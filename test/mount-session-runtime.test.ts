import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMountSessionRuntime } from "../packages/cli/src/runtime/mount-session-main.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { createCli } from "../packages/cli/src/create-cli.ts";

// Full fake relay api (all methods createMountedTurnOwnedRelay returns), so a
// test can inject `createTurnRelay` and capture the relay INPUT.
function fakeRelayApi(): ReturnType<typeof createMountedTurnOwnedRelay> {
	return {
		getWaitingGate: () => ({
			isBlocked: () => false,
			renderBlockedMessage: () => "",
			onCancel: () => {},
		}),
		refreshOwnerView: vi.fn(),
		checkIdleActions: vi.fn(() => Promise.resolve()),
		handbackResolvedContent: vi.fn(async () => {}),
		handleTurnEvent: vi.fn(async () => {}),
		settleHeldTurnEvent: vi.fn(),
		isCopyFallbackArmed: vi.fn(() => false),
		noEventFallbackDue: vi.fn(() => false),
		recordEzioFidelityDecision: vi.fn(),
		acceptPendingHandoff: vi.fn(),
		amendPendingHandoff: vi.fn(),
		declinePendingHandoff: vi.fn(),
		deferPendingHandoff: vi.fn(),
		handBackTo: vi.fn(),
		handleOwnerDisconnect: vi.fn(),
		handleOwnerInput: vi.fn(async () => false),
	} as unknown as ReturnType<typeof createMountedTurnOwnedRelay>;
}

describe("mount session runtime", () => {
	it("starts the live session before completing the claim and records mounted session metadata", async () => {
		const callOrder: string[] = [];
		const completeAttachClaim = vi.fn(() => {
			callOrder.push("complete-claim");
			return {
				collabId: "collab_mount",
				sessionId: "session_codex_mount",
				agentType: "codex",
			};
		});
		const liveSession = {
			start: () => {
				callOrder.push("live-start");
				return Promise.resolve();
			},
			stop: () => Promise.resolve(),
		};
		const runtime = createMountSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys031",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_mount_1",
			secret: "secret_mount",
			broker: {
				control: {
					completeAttachClaim,
					listSessionBindings: () => [],
					listSessions: () => [],
					markSessionDegraded: vi.fn(),
					getRelayTurnState: () => ({ collabId: "collab_mount", turnOwner: "none", waitingAgent: null, unresolvedHandoffId: null, handoffState: "idle", handoffAgeMs: null }),
					getRelayHandoff: () => null,
				},
				stop: () => Promise.resolve(),
			} as never,
			createInteractiveSession: () => ({
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput() {},
				sendLocalMessage() {},
				onExit() {},
			}),
			createLiveSession: () => liveSession as never,
			createProvider: () => ({
				getIdentity: () => ({ providerId: "codex-cli", toolFamily: "codex", providerVersion: "1.0.0" }),
				getCapabilities: () => ({
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: true,
					supportsLocalBuffering: true,
					supportsLaunchHooks: false,
					extensions: {},
				}),
				getHealthState: () => "healthy" as const,
				handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
			}),
			runLoop: () => Promise.resolve(async () => {}),
		});

		await runtime.start();

		expect(callOrder).toEqual(["live-start", "complete-claim"]);
		expect(completeAttachClaim).toHaveBeenCalledWith(expect.objectContaining({ bindingSource: "mounted" }));
	});

	it("does not consume the claim when provider startup fails", async () => {
		const completeAttachClaim = vi.fn();
		const runtime = createMountSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys031",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_mount_1",
			secret: "secret_mount",
			broker: {
				control: {
					completeAttachClaim,
				},
				stop: () => Promise.resolve(),
			} as never,
			createInteractiveSession: () => ({
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput() {},
				sendLocalMessage() {},
				onExit() {},
			}),
			createLiveSession: () => ({
				start: () => Promise.reject(new Error("provider failed to launch")),
				stop: () => Promise.resolve(),
			}) as never,
			createProvider: () => ({
				getIdentity: () => ({ providerId: "codex-cli", toolFamily: "codex", providerVersion: "1.0.0" }),
				getCapabilities: () => ({
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: true,
					supportsLocalBuffering: true,
					supportsLaunchHooks: false,
					extensions: {},
				}),
				getHealthState: () => "healthy" as const,
				handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
			}),
			runLoop: () => Promise.resolve(async () => {}),
		});

		await expect(runtime.start()).rejects.toThrow("provider failed to launch");
		expect(completeAttachClaim).not.toHaveBeenCalled();
	});
});

describe("mount session runtime — degradation on exit", () => {
	it("marks session degraded in the broker when the provider exits unexpectedly", async () => {
		const completeAttachClaim = vi.fn(() => ({
			collabId: "collab_mount",
			sessionId: "session_codex_mount",
			agentType: "codex",
		}));
		const markSessionDegraded = vi.fn();

		let capturedOnExit: (() => void) | null = null;

		const processExitCalls: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			processExitCalls.push(code as number);
			return undefined as never;
		});

		try {

			const runtime = createMountSessionRuntime({
				target: "codex",
				ttyPath: "/dev/ttys031",
				workspaceRoot: "/tmp/workspace",
				claimId: "claim_mount_1",
				secret: "secret_mount",
				broker: {
					control: {
						completeAttachClaim,
						listSessionBindings: () => [],
						listSessions: () => [],
						markSessionDegraded,
						getRelayTurnState: () => ({ collabId: "collab_mount", turnOwner: "none", waitingAgent: null, unresolvedHandoffId: null, handoffState: "idle", handoffAgeMs: null }),
						getRelayHandoff: () => null,
					},
					stop: () => Promise.resolve(),
				} as never,
				createInteractiveSession: () => ({
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					writeUserInput() {},
					sendLocalMessage() {},
					onExit(handler: () => void) { capturedOnExit = handler; },
				}),
				createLiveSession: () => ({ start: () => Promise.resolve(), stop: () => Promise.resolve() }) as never,
				createProvider: () => ({
					getIdentity: () => ({ providerId: "codex-cli", toolFamily: "codex", providerVersion: "1.0.0" }),
					getCapabilities: () => ({
						supportsDirectPackets: true,
						supportsNormalization: false,
						supportsRelayInterception: true,
						supportsLocalBuffering: true,
						supportsLaunchHooks: false,
						extensions: {},
					}),
					getHealthState: () => "healthy" as const,
					handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
				}),
				runLoop: () => Promise.resolve(async () => {}),
			});

			await runtime.start();
			expect(capturedOnExit).not.toBeNull();

			// Simulate provider process exit
			capturedOnExit!();
			// Allow microtasks to flush
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			expect(markSessionDegraded).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "session_codex_mount" }),
			);
		} finally {
			exitSpy.mockRestore();
		}
	});
});

describe("mount session runtime — idle timer", () => {
	it("calls checkIdleActions when idle threshold is exceeded in the ownerRefreshTimer", async () => {
		vi.useFakeTimers();

		const checkIdleActions = vi.fn(() => Promise.resolve());
		const completeAttachClaim = vi.fn(() => ({
			collabId: "collab_idle_wire",
			sessionId: "session_idle",
			agentType: "codex",
		}));
		// Relay factory injection: return a fake relay that exposes our spy
		const createTurnRelay: typeof createMountedTurnOwnedRelay = (_relayInput) => ({
			getWaitingGate: () => ({
				isBlocked: () => false,
				renderBlockedMessage: () => "",
				onCancel: () => {},
			}),
			refreshOwnerView: vi.fn(),
			checkIdleActions,
			handbackResolvedContent: vi.fn(async () => {}),
			handleTurnEvent: vi.fn(async () => {}),
			settleHeldTurnEvent: vi.fn(),
			isCopyFallbackArmed: vi.fn(() => false),
			noEventFallbackDue: vi.fn(() => false),
			recordEzioFidelityDecision: vi.fn(),
			acceptPendingHandoff: vi.fn(),
			amendPendingHandoff: vi.fn(),
			declinePendingHandoff: vi.fn(),
			deferPendingHandoff: vi.fn(),
			handBackTo: vi.fn(),
			handleOwnerDisconnect: vi.fn(),
			handleOwnerInput: vi.fn(async () => false),
		});

		const runtime = createMountSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys031",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_idle",
			secret: "secret_idle",
			broker: {
				control: {
					completeAttachClaim,
					listSessionBindings: () => [],
					listSessions: () => [],
					markSessionDegraded: vi.fn(),
					getRelayTurnState: () => ({
						collabId: "collab_idle_wire",
						turnOwner: "none" as const,
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle" as const,
						handoffAgeMs: null,
					}),
					getRelayHandoff: () => null,
				},
				stop: () => Promise.resolve(),
			} as never,
			createInteractiveSession: () => ({
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput: vi.fn(),
				sendLocalMessage: vi.fn(),
				onProviderOutput: vi.fn(),
				onExit: vi.fn(),
			}),
			createProvider: () =>
				({
					getIdentity: () => ({ providerId: "codex", toolFamily: "codex", providerVersion: "1" }),
					getCapabilities: () => ({
						supportsDirectPackets: false,
						supportsNormalization: false,
						supportsRelayInterception: false,
						supportsLocalBuffering: false,
						supportsLaunchHooks: false,
						extensions: {},
					}),
				}) as never,
			createLiveSession: () =>
				({
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					withPausedInput: async <T>(fn: () => Promise<T>) => fn(),
					isPaused: () => false,
				}) as never,
			runLoop: () => Promise.resolve(() => Promise.resolve()),
			createTurnRelay,
		});

		void runtime.start();
		// Advance past the 30 000 ms default idle threshold + one timer tick
		await vi.advanceTimersByTimeAsync(31_000);

		expect(checkIdleActions).toHaveBeenCalled();

		vi.useRealTimers();
	});
});

describe("mount session runtime — turn-event production wiring", () => {
	it("event-enabled claude mount passes eventPathEnabled + suppressQuiescenceHandback to the relay and supplies idleElapsedMs", async () => {
		const prevRoot = process.env["AI_WHISPER_STATE_ROOT"];
		process.env["AI_WHISPER_STATE_ROOT"] = mkdtempSync(
			join(tmpdir(), "aiw-mount-wire-"),
		);
		const workspaceRoot = mkdtempSync(join(tmpdir(), "aiw-ws-evt-"));
		vi.useFakeTimers();
		try {
			let capturedRelayInput: Record<string, unknown> | undefined;
			const checkIdleActions = vi.fn((_idleElapsedMs?: number) =>
				Promise.resolve(),
			);
			const createTurnRelay: typeof createMountedTurnOwnedRelay = (relayInput) => {
				capturedRelayInput = relayInput as unknown as Record<string, unknown>;
				return { ...fakeRelayApi(), checkIdleActions };
			};
			const runtime = createMountSessionRuntime({
				target: "claude",
				ttyPath: "/dev/ttys032",
				workspaceRoot,
				claimId: "claim_evt",
				secret: "secret_evt",
				// Rollout enablement ON for claude — this is what production resolves
				// from the --turn-events flag / AI_WHISPER_TURN_EVENTS env.
				turnEventsEnablement: { claude: true, codex: false, agy: false },
				broker: {
					control: {
						completeAttachClaim: vi.fn(() => ({
							collabId: "collab_evt",
							sessionId: "session_evt",
							agentType: "claude",
						})),
						listSessionBindings: () => [],
						listSessions: () => [],
						markSessionDegraded: vi.fn(),
						getRelayTurnState: () => ({
							collabId: "collab_evt",
							turnOwner: "none" as const,
							waitingAgent: null,
							unresolvedHandoffId: null,
							handoffState: "idle" as const,
							handoffAgeMs: null,
						}),
						getRelayHandoff: () => null,
					},
					stop: () => Promise.resolve(),
				} as never,
				// claude-like session: NO onTurnFinished (so suppression can only come
				// from the event-path enablement, exactly the bug under test).
				createInteractiveSession: () => ({
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					writeUserInput: vi.fn(),
					sendLocalMessage: vi.fn(),
					onProviderOutput: vi.fn(),
					onExit: vi.fn(),
				}),
				createProvider: () =>
					({
						getIdentity: () => ({
							providerId: "claude",
							toolFamily: "claude",
							providerVersion: "1",
						}),
						getCapabilities: () => ({
							supportsDirectPackets: false,
							supportsNormalization: false,
							supportsRelayInterception: false,
							supportsLocalBuffering: false,
							supportsLaunchHooks: false,
							extensions: {},
						}),
					}) as never,
				createLiveSession: () =>
					({
						start: () => Promise.resolve(),
						stop: () => Promise.resolve(),
						withPausedInput: async <T>(fn: () => Promise<T>) => fn(),
						isPaused: () => false,
					}) as never,
				runLoop: () => Promise.resolve(() => Promise.resolve()),
				createTurnRelay,
				// Fake listener: avoid opening a real unix socket in the unit test.
				createTurnEventListener: (async () => ({
					socketPath: "/tmp/fake.sock",
					close: async () => {},
				})) as never,
			});

			void runtime.start();
			await vi.advanceTimersByTimeAsync(31_000); // past the 30s idle threshold

			// THE regression: production must enable suppression + the event path, or a
			// positive-mismatch turn could still trigger the unsuppressed /copy handback.
			expect(capturedRelayInput?.["eventPathEnabled"]).toBe(true);
			expect(capturedRelayInput?.["suppressQuiescenceHandback"]).toBe(true);
			expect(capturedRelayInput?.["workspaceId"]).toBeTruthy();
			// And the idle timer must pass a real elapsed clock (not the 0 default), so
			// the no-event grace fallback can actually fire in production.
			expect(checkIdleActions).toHaveBeenCalled();
			const elapsedArg = checkIdleActions.mock.calls[0]?.[0];
			expect(typeof elapsedArg).toBe("number");
			expect(elapsedArg).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
			if (prevRoot === undefined) delete process.env["AI_WHISPER_STATE_ROOT"];
			else process.env["AI_WHISPER_STATE_ROOT"] = prevRoot;
		}
	});
});

describe("cli mount wiring", () => {
	it("registers the collab mount command", () => {
		const collab = createCli().commands.find((command) => command.name() === "collab");
		expect(collab?.commands.map((command) => command.name())).toContain("mount");
	});
});
