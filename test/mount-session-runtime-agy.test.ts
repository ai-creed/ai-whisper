import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMountSessionRuntime } from "../packages/cli/src/runtime/mount-session-main.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { AGY_HOOKS_GROUP } from "../packages/cli/src/runtime/turn-events-config.ts";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";

type CapturedAgyListenerInput = {
	provider: string;
	agy?: { mode: string; mountCwd: string };
	onEvent: (e: TurnEvent) => void;
	onActivity: (info: { toolInFlight: boolean }) => void;
};

// Full fake relay api (mirrors fakeRelayApi in mount-session-runtime.test.ts).
function fakeRelayApi(
	extra: Partial<ReturnType<typeof createMountedTurnOwnedRelay>> = {},
): ReturnType<typeof createMountedTurnOwnedRelay> {
	return {
		getWaitingGate: () => ({ isBlocked: () => false, renderBlockedMessage: () => "", onCancel: () => {} }),
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
		...extra,
	} as unknown as ReturnType<typeof createMountedTurnOwnedRelay>;
}

const AGY_CAPS = {
	supportsDirectPackets: true,
	supportsNormalization: true,
	supportsRelayInterception: true,
	supportsLocalBuffering: false,
	supportsLaunchHooks: true,
	extensions: {},
};

function agyBroker(collabId: string, sessionId: string) {
	return {
		control: {
			completeAttachClaim: vi.fn(() => ({ collabId, sessionId, agentType: "agy" })),
			listSessionBindings: () => [],
			listSessions: () => [],
			markSessionDegraded: vi.fn(),
			getRelayTurnState: () => ({
				collabId,
				turnOwner: "none" as const,
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle" as const,
				handoffAgeMs: null,
			}),
			getRelayHandoff: () => null,
		},
		stop: () => Promise.resolve(),
	} as never;
}

function agyInteractiveSession(onExitSink?: (h: () => void) => void) {
	return {
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		writeUserInput: vi.fn(),
		sendLocalMessage: vi.fn(),
		onProviderOutput: vi.fn(),
		onExit: (h: () => void) => onExitSink?.(h),
	};
}

describe("mount session runtime — agy turn-event wiring (faked hook stream)", () => {
	let prevRoot: string | undefined;
	let prevScope: string | undefined;
	beforeEach(() => {
		prevRoot = process.env["AI_WHISPER_STATE_ROOT"];
		prevScope = process.env["AI_WHISPER_AGY_HOOKS_SCOPE"];
		process.env["AI_WHISPER_STATE_ROOT"] = mkdtempSync(join(tmpdir(), "aiw-agy-mount-"));
		delete process.env["AI_WHISPER_AGY_HOOKS_SCOPE"]; // default = workspace
	});
	afterEach(() => {
		if (prevRoot === undefined) delete process.env["AI_WHISPER_STATE_ROOT"];
		else process.env["AI_WHISPER_STATE_ROOT"] = prevRoot;
		if (prevScope === undefined) delete process.env["AI_WHISPER_AGY_HOOKS_SCOPE"];
		else process.env["AI_WHISPER_AGY_HOOKS_SCOPE"] = prevScope;
		vi.useRealTimers();
	});

	it("installs the hooks group before launch, wires the agy listener in workspace mode, and removes the group on teardown", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "aiw-agy-ws-"));
		const hooksFile = join(workspaceRoot, ".agents", "hooks.json");
		let hooksExistedAtLaunch = false;
		let listenerInput: CapturedAgyListenerInput | undefined;
		let capturedOnExit: (() => void) | null = null;

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			const runtime = createMountSessionRuntime({
				target: "agy",
				ttyPath: "/dev/ttys040",
				workspaceRoot,
				claimId: "claim_agy",
				secret: "secret_agy",
				turnEventsEnablement: { claude: false, codex: false, agy: true },
				broker: agyBroker("collab_agy", "session_agy"),
				createInteractiveSession: () => agyInteractiveSession((h) => (capturedOnExit = h)),
				createLiveSession: () =>
					({
						start: () => {
							// Ordering proof: the hooks group must already exist at launch.
							hooksExistedAtLaunch = existsSync(hooksFile);
							return Promise.resolve();
						},
						stop: () => Promise.resolve(),
						withPausedInput: async <T>(fn: () => Promise<T>) => fn(),
						isPaused: () => false,
					}) as never,
				createProvider: () =>
					({
						getIdentity: () => ({ providerId: "google-antigravity-cli", toolFamily: "antigravity", providerVersion: "1.0.0" }),
						getCapabilities: () => AGY_CAPS,
						getHealthState: () => "healthy" as const,
						handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
					}) as never,
				runLoop: () => Promise.resolve(() => Promise.resolve()),
				createTurnRelay: () => fakeRelayApi(),
				createTurnEventListener: (async (inp: unknown) => {
					listenerInput = inp as CapturedAgyListenerInput;
					return { socketPath: "/tmp/fake-agy.sock", close: async () => {} };
				}) as never,
			});

			await runtime.start();

			// Criterion 5 (install-before-launch): the group existed when the provider launched.
			expect(hooksExistedAtLaunch).toBe(true);
			expect((JSON.parse(readFileSync(hooksFile, "utf8")) as Record<string, unknown>)[AGY_HOOKS_GROUP]).toBeDefined();

			// Listener wired for agy in the DEFAULT (workspace) adoption mode, with onActivity.
			expect(listenerInput).toBeDefined();
			const li = listenerInput!;
			expect(li.provider).toBe("agy");
			expect(li.agy!.mode).toBe("workspace");
			expect(li.agy!.mountCwd).toBe(workspaceRoot);
			expect(typeof li.onEvent).toBe("function");
			expect(typeof li.onActivity).toBe("function");

			// Criterion 5 (teardown): provider exit → stop() removes ONLY our group.
			expect(capturedOnExit).not.toBeNull();
			capturedOnExit!();
			await new Promise((r) => setTimeout(r, 20));
			expect((JSON.parse(readFileSync(hooksFile, "utf8")) as Record<string, unknown>)[AGY_HOOKS_GROUP]).toBeUndefined();
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("routes a gated Stop to the relay and suppresses idle while a tool is in flight (criteria 1 & 3)", async () => {
		vi.useFakeTimers();
		const workspaceRoot = mkdtempSync(join(tmpdir(), "aiw-agy-ws2-"));
		let listenerInput: CapturedAgyListenerInput | undefined;
		const checkIdleActions = vi.fn(() => Promise.resolve());
		const handleTurnEvent = vi.fn(async () => {});

		const runtime = createMountSessionRuntime({
			target: "agy",
			ttyPath: "/dev/ttys041",
			workspaceRoot,
			claimId: "claim_agy2",
			secret: "secret_agy2",
			turnEventsEnablement: { claude: false, codex: false, agy: true },
			broker: agyBroker("collab_agy2", "session_agy2"),
			createInteractiveSession: () => agyInteractiveSession(),
			createLiveSession: () =>
				({
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					withPausedInput: async <T>(fn: () => Promise<T>) => fn(),
					isPaused: () => false,
				}) as never,
			createProvider: () =>
				({
					getIdentity: () => ({ providerId: "google-antigravity-cli", toolFamily: "antigravity", providerVersion: "1.0.0" }),
					getCapabilities: () => AGY_CAPS,
					getHealthState: () => "healthy" as const,
					handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
				}) as never,
			runLoop: () => Promise.resolve(() => Promise.resolve()),
			createTurnRelay: () => fakeRelayApi({ checkIdleActions, handleTurnEvent }),
			createTurnEventListener: (async (inp: unknown) => {
				listenerInput = inp as CapturedAgyListenerInput;
				return { socketPath: "/tmp/fake-agy2.sock", close: async () => {} };
			}) as never,
		});

		void runtime.start();
		await vi.advanceTimersByTimeAsync(10); // let start() reach listener creation
		expect(listenerInput).toBeDefined();
		const li = listenerInput!;

		// A gated Stop turn-end (as AgyEventReceiver would emit) routes to the relay once.
		const turnEnd: TurnEvent = {
			provider: "agy",
			workspaceId: "w",
			cwd: workspaceRoot,
			sessionOrThreadId: "parent",
			turnId: null,
			message: "",
			inputMessages: [],
			receivedAt: "2026-06-27T00:00:00.000Z",
		};
		li.onEvent(turnEnd);
		await vi.advanceTimersByTimeAsync(0);
		expect(handleTurnEvent).toHaveBeenCalledTimes(1);

		// PreToolUse with no PostToolUse → tool in flight → idle MUST NOT fire.
		li.onActivity({ toolInFlight: true });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(checkIdleActions).not.toHaveBeenCalled();

		// PostToolUse closes the bracket → idle fallback resumes.
		li.onActivity({ toolInFlight: false });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(checkIdleActions).toHaveBeenCalled();
	});

	it("removes the hooks group even when provider startup fails (teardown-leak fix)", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "aiw-agy-startfail-"));
		const hooksFile = join(workspaceRoot, ".agents", "hooks.json");

		const runtime = createMountSessionRuntime({
			target: "agy",
			ttyPath: "/dev/ttys042",
			workspaceRoot,
			claimId: "claim_agy_fail",
			secret: "secret_agy_fail",
			turnEventsEnablement: { claude: false, codex: false, agy: true },
			broker: agyBroker("collab_agy_fail", "session_agy_fail"),
			createInteractiveSession: () => agyInteractiveSession(),
			createLiveSession: () =>
				({
					start: () => Promise.reject(new Error("provider failed to launch")),
					stop: () => Promise.resolve(),
				}) as never,
			createProvider: () =>
				({
					getIdentity: () => ({ providerId: "google-antigravity-cli", toolFamily: "antigravity", providerVersion: "1.0.0" }),
					getCapabilities: () => AGY_CAPS,
					getHealthState: () => "healthy" as const,
					handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
				}) as never,
			runLoop: () => Promise.resolve(() => Promise.resolve()),
			createTurnRelay: () => fakeRelayApi(),
		});

		await expect(runtime.start()).rejects.toThrow("provider failed to launch");

		// The hooks file WILL have been written pre-launch; after the catch the group must be gone.
		const map = JSON.parse(readFileSync(hooksFile, "utf8")) as Record<string, unknown>;
		expect(map[AGY_HOOKS_GROUP]).toBeUndefined();
	});
});
