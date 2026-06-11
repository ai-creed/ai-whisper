import { fileURLToPath } from "node:url";
import type { AgentType,  BrokerRuntime } from "@ai-whisper/broker";
import type { RelayDirective } from "@ai-whisper/shared";
import {
	openDatabase,
	deleteSessionAttachment,
	getRecoveryState,
	reapSupersededSessions,
	releaseCaptureLease,
	upsertRecoveryState,
} from "@ai-whisper/broker";
import { getSharedSqlitePath, getStateSocketsDir, getStateLogsDir } from "./state-root.js";
import { workspaceIdFromPath } from "./workspace-id.js";
import {
	writeClaudeSettingsFile,
	codexNotifyArgs,
	type TurnEventsEnablement,
} from "./turn-events-config.js";
import {
	createTurnEventListener,
	type TurnEventListener,
} from "./mount-turn-event-listener.js";
import { createLiveSessionRuntime } from "./live-session.js";
import { runCompanionAgentLoop } from "./companion-agent-loop.js";
import {
	createInteractiveSessionForTarget,
	createProviderForTarget,
} from "./providers.js";
import { createContextInjector } from "./context-injector.js";
import { createCliSessionId } from "./id-factory.js";
import { recordMountedSession } from "../commands/collab/mount.js";
import { createRelayPaneWriter } from "./relay-pane-writer.js";
import { createMountedTurnOwnedRelay } from "./mounted-turn-owned-relay.js";
import {
	createLocalModalConfirm,
	createLocalMultilineComposer,
	createLocalModalLineReader,
} from "./local-multiline-composer.js";
import { createAssistantTurnCapture } from "./assistant-turn-capture.js";
import { captureClipboardHandback } from "./clipboard-handback-capture.js";
import { captureHandbackText as runLeasedCapture } from "./capture-handback-text.js";
import { makeChangeCountReader } from "./clipboard-change-count.js";
import {
	submitInjectedProviderInput,
	type CodexSubmitStrategy,
} from "./provider-submit-strategy.js";
import { createBracketedPasteDetector } from "./bracketed-paste-detector.js";
import { createRuntimeDebugLogger } from "./runtime-debug-log.js";

/**
 * Build the createRelayHandoff input for an operator-issued @@ directive in a
 * mounted session: the handoff's sender is the MOUNTED agent (`mountTarget`), the
 * target is the directive's recipient. Pure + exported so the sender contract is
 * unit-testable (the inline `onRelay` closure calls this). The `pull` directive is
 * handled earlier and never reaches here, so `directive.target` is an `AgentType`.
 */
export function buildRelayHandoffInput(input: {
	mountTarget: AgentType;
	directive: { target: AgentType; instruction: string };
	collabId: string;
	now: string;
}): {
	handoffId: string;
	collabId: string;
	senderAgent: AgentType;
	targetAgent: AgentType;
	requestText: string;
	now: string;
} {
	return {
		handoffId: `handoff_${input.now.replace(/[^0-9]/g, "")}`,
		collabId: input.collabId,
		senderAgent: input.mountTarget,
		targetAgent: input.directive.target,
		requestText: input.directive.instruction,
		now: input.now,
	};
}

/** Operator override for the codex submit strategy (AI_WHISPER_CODEX_SUBMIT_STRATEGY). */
function resolveCodexSubmitStrategyOverride(): CodexSubmitStrategy | undefined {
	const raw = process.env.AI_WHISPER_CODEX_SUBMIT_STRATEGY;
	if (raw === "bracketed" || raw === "keystream" || raw === "chunk") return raw;
	return undefined;
}

// Positive-integer env override, else undefined (relay applies its own default).
function resolvePositiveIntEnv(name: string): number | undefined {
	const n = Number(process.env[name] ?? "");
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

// changeCount reader for the clipboard capture lease (component 6). Degrades to
// null off-darwin or when the native helper is missing, so the ownership check
// is skipped rather than blocking capture.
const readChangeCount = makeChangeCountReader();

// Best-effort reap of superseded `session` rows for a (collab, agent), keeping
// only the active/kept session id. Wrapped so a reaping failure is logged and
// NEVER breaks mount registration or stop/teardown (acceptance criterion 2).
// The `reap`/`logError` seams are injected in tests; production opens the
// shared DB and delegates to reapSupersededSessions.
export function safeReapSessions(input: {
	collabId: string;
	agentType: string;
	keepSessionId: string;
	reap?: (collabId: string, agentType: string, keepSessionId: string) => number;
	logError?: (err: unknown) => void;
}): void {
	const reap =
		input.reap ??
		((collabId, agentType, keepSessionId) => {
			const db = openDatabase(getSharedSqlitePath());
			try {
				return reapSupersededSessions(db, collabId, agentType, keepSessionId);
			} finally {
				db.close();
			}
		});
	try {
		reap(input.collabId, input.agentType, input.keepSessionId);
	} catch (err) {
		(input.logError ??
			((e: unknown) => {
				console.error("reapSupersededSessions failed (non-fatal)", e);
			}))(err);
	}
}

type ReapLifecycleInput = {
	collabId: string;
	agentType: string;
	keepSessionId: string;
	reap?: (collabId: string, agentType: string, keepSessionId: string) => number;
	logError?: (err: unknown) => void;
};

// The mount-registration reap path: after a NEW session becomes the active/bound
// one, drop superseded rows for this (collab, agent). Named + exported so the
// mount path's failure-isolation is unit-tested (criterion 2) — a throwing reaper
// must never propagate out of mount. `start()` is interactive and not unit-drivable,
// so this is the testable representation of the call site.
export function reapStaleSessionsOnMount(input: ReapLifecycleInput): void {
	safeReapSessions(input);
}

// The stop/teardown reap path: after the session is marked degraded, drop
// superseded rows keeping that surviving row. A throwing reaper must never
// propagate out of stop (criterion 2).
export function reapStaleSessionsOnTeardown(input: ReapLifecycleInput): void {
	safeReapSessions(input);
}

export function createMountSessionRuntime(input: {
	target: AgentType;
	ttyPath: string;
	workspaceRoot: string;
	claimId: string;
	secret: string;
	broker: BrokerRuntime;
	/**
	 * Extra args forwarded to the visible agent spawn (codex/claude). Wired
	 * into createInteractiveSessionForTarget only — createProviderForTarget
	 * (the non-visible relay/companion side) is unaffected.
	 */
	passthroughArgs?: string[];
	/**
	 * Turn-events enablement resolved by runCollabMount (flag > env > default OFF).
	 * When a provider's flag is true, the interactive session is launched with the
	 * provider-specific hook injection (claude: --settings, codex: -c notify) and
	 * a socket listener is started to receive the shim's forwarded events.
	 */
	turnEventsEnablement?: TurnEventsEnablement;
	createProvider?: typeof createProviderForTarget;
	createInteractiveSession?: typeof createInteractiveSessionForTarget;
	createLiveSession?: typeof createLiveSessionRuntime;
	runLoop?: typeof runCompanionAgentLoop;
	createTurnRelay?: typeof createMountedTurnOwnedRelay;
	createTurnEventListener?: typeof createTurnEventListener;
}) {
	return {
		async start() {
			const sessionId = createCliSessionId(input.target, new Date().toISOString());
			const provider = (input.createProvider ?? createProviderForTarget)(input.target);

			// Turn-events injection: pre-compute the shim path and provider-specific
			// hook config before spawning the interactive session so flags land in argv.
			const _eventEnabled =
				(input.target === "claude" && (input.turnEventsEnablement?.claude ?? false)) ||
				(input.target === "codex" && (input.turnEventsEnablement?.codex ?? false));
			let _turnEventsInjection:
				| { claudeSettingsFile?: string; codexNotify?: string[] }
				| undefined;
			if (_eventEnabled) {
				const shimPath = fileURLToPath(new URL("../bin/turn-event-shim.js", import.meta.url));
				const socketsDir = getStateSocketsDir();
				const logsDir = getStateLogsDir();
				if (input.target === "claude") {
					const settingsFile = writeClaudeSettingsFile({
						stateRoot: getStateLogsDir().replace(/[/\\]logs$/, ""),
						workspaceId: workspaceIdFromPath(input.workspaceRoot),
						shimPath,
						socketsDir,
						logsDir,
					});
					_turnEventsInjection = { claudeSettingsFile: settingsFile };
				} else if (input.target === "codex") {
					_turnEventsInjection = {
						codexNotify: codexNotifyArgs({ shimPath, socketsDir, logsDir }),
					};
				}
			}

			const interactiveSession = (input.createInteractiveSession ?? createInteractiveSessionForTarget)({
				target: input.target,
				cwd: input.workspaceRoot,
				stdout: process.stdout,
				passthroughArgs: input.passthroughArgs ?? [],
				...(_turnEventsInjection !== undefined ? { turnEvents: _turnEventsInjection } : {}),
			});

			let ownerRefreshTimer: ReturnType<typeof setInterval> | null = null;
			let stopLoop = async () => {};
			let liveSessionStarted = false;
			let stopping = false;
			let closeLineReader = () => {};
			let turnEventListener: TurnEventListener | null = null;

			// liveSession is set after the collab claim resolves so collabId is available
			// for turnRelay, allowing externalInputGate to be passed directly instead of
			// via a lazy getter (spread evaluates getters once, freezing undefined at call time).
			let liveSession: ReturnType<typeof createLiveSessionRuntime> | null = null;
			let relayPaneWriter: ReturnType<typeof createRelayPaneWriter> | null = null;
			let turnRelay: ReturnType<typeof createMountedTurnOwnedRelay> | null = null;
			const relayPaneWriterProxy = {
				status(event: { content: string; now: string }) {
					relayPaneWriter?.status(event);
				},
			} as ReturnType<typeof createRelayPaneWriter>;

			const stop = async () => {
				if (stopping) return;
				stopping = true;
				if (ownerRefreshTimer !== null) {
					clearInterval(ownerRefreshTimer);
					ownerRefreshTimer = null;
				}
				closeLineReader();
				await stopLoop();
				if (liveSessionStarted && liveSession) {
					await liveSession.stop();
				}
				// Mark the session degraded before stopping the broker so status/inspect
				// correctly reflect that the mounted provider is no longer running.
				if (resolvedClaim) {
					try {
						input.broker.control.markSessionDegraded({
							sessionId: resolvedClaim.sessionId,
							now: new Date().toISOString(),
						});
					} catch {
						// Best-effort; broker may already be unreachable.
					}
					// Reap any superseded session rows for this (collab, agent) on
					// teardown, keeping the session we just degraded (the surviving
					// active row). Best-effort; never breaks stop (criterion 2).
					reapStaleSessionsOnTeardown({
						collabId: resolvedClaim.collabId,
						agentType: input.target,
						keepSessionId: resolvedClaim.sessionId,
					});
				}
				if (resolvedClaim) {
					try {
						const db = openDatabase(getSharedSqlitePath());
						try {
							deleteSessionAttachment(db, {
								collabId: resolvedClaim.collabId,
								agentType: input.target,
								attachmentKind: "mounted",
							});
							// Release any held capture lease on teardown (mirrors dead-daemon
							// handling; the startup sweep / TTL is the backstop if missed).
							releaseCaptureLease(db, resolvedClaim.collabId);
						} finally {
							db.close();
						}
					} catch {
						// Best-effort cleanup; the row may already be gone.
					}
				}
				if (turnEventListener) {
					try {
						await turnEventListener.close();
					} catch {
						// Best-effort; never blocks teardown.
					}
					turnEventListener = null;
				}
				await input.broker.stop();
			};

			// resolvedClaim is needed in stop() and onRelay; hoist declaration above stop().
			let resolvedClaim: { collabId: string; sessionId: string; agentType: string } | null = null;

			process.once("SIGINT", () => void stop().then(() => process.exit(0)));
			process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

			const idleThresholdMs = Math.max(
				5_000,
				Number(process.env.AI_WHISPER_IDLE_THRESHOLD_MS ?? "") || 30_000,
			);
			let lastActivityAt = Date.now();

			try {
				const turnCapture = createAssistantTurnCapture();
				// Per-mount learned /copy changeCount signature (one /copy advances
				// changeCount by a fixed agent-specific amount: codex 1, Claude Code 3).
				// Persists across captures so a multi-write /copy isn't mistaken for a
				// foreign write. See captureHandbackText.
				const copySignature: { delta: number | null } = { delta: null };
				const bracketedPaste = createBracketedPasteDetector();
				const codexStrategyOverride = resolveCodexSubmitStrategyOverride();
				const debugLog = createRuntimeDebugLogger({
					logPath: process.env.AI_WHISPER_DEBUG_INPUT_LOG ?? null,
					sessionId: process.env.AI_WHISPER_SESSION_ID ?? null,
				});
				const writeInjectedInput = (channel: string, value: string) => {
					debugLog({
						type: "programmatic-write",
						channel,
						data: value,
					});
					interactiveSession.writeUserInput(value);
				};
				const submitInjectedInput = async (text: string) => {
					debugLog({
						type: "programmatic-submit",
						channel: "mounted-submit",
						data: text,
					});
					await submitInjectedProviderInput({
						target: input.target,
						text,
						writeUserInput: (value) =>
							writeInjectedInput("mounted-submit", value),
						bracketedPasteEnabled: bracketedPaste.enabled,
						strategyOverride: codexStrategyOverride,
					});
				};
				interactiveSession.onProviderOutput?.((data: string) => {
					lastActivityAt = Date.now();
					turnCapture.recordProviderOutput(data);
					bracketedPaste.observe(data);
				});

				const onRelay = (
					directive: RelayDirective,
					sendNow: (message: string) => void,
				): Promise<string | null> => {
					if (!resolvedClaim) {
						throw new Error("Relay not available: session claim not yet completed");
					}

						if (directive.target === "pull") {
							const injector = createContextInjector({ broker: input.broker, collabId: resolvedClaim.collabId, sessionId: resolvedClaim.sessionId });
							const activeThread = input.broker.control.listThreads(resolvedClaim.collabId).find((t) => t.active);
							if (!activeThread) {
								sendNow("[ai-whisper] No active thread to pull context from.\n");
								return Promise.resolve(null);
							}
						const result = injector.injectContext({ userInput: "", activeThreadId: activeThread.threadId });
						if (result.injected) {
							writeInjectedInput("context-inject", result.payload);
							sendNow(`\u001b[2m↳ relay context attached (${result.summary})\u001b[0m\n`);
						} else {
							sendNow("[ai-whisper] No pending relay context to inject.\n");
						}
							return Promise.resolve(null);
						}

					relayPaneWriter?.relayDirective({
						senderAgent: input.target,
						receiverAgent: directive.target,
						instruction: directive.instruction,
						now: new Date().toISOString(),
					});

					const handoffNow = new Date().toISOString();
					input.broker.control.createRelayHandoff(
						buildRelayHandoffInput({
							mountTarget: input.target,
							// `pull` returns earlier, so this is a non-pull AgentType.
							directive: {
								target: directive.target,
								instruction: directive.instruction,
							},
							collabId: resolvedClaim.collabId,
							now: handoffNow,
						}),
					);

					sendNow(`[ai-whisper] Handed turn to ${directive.target}.`);

						return Promise.resolve(null);
					};

				// Mounted sessions own the terminal; process.stdin is the real tty read side.
				// The live-session runtime intercepts inline @@ relay directives from stdin.
				liveSession = (input.createLiveSession ?? createLiveSessionRuntime)({
					interactiveSession,
					stdin: process.stdin,
					stdout: process.stdout,
					relayPaneWriter: relayPaneWriterProxy,
					externalInputGate: {
						isBlocked: () => turnRelay?.getWaitingGate().isBlocked() ?? false,
						renderBlockedMessage: () =>
							turnRelay?.getWaitingGate().renderBlockedMessage() ?? "",
						onCancel: () => {
							turnRelay?.getWaitingGate().onCancel();
						},
					},
					externalInputRouter: {
						handleInput: async (text) => {
							return (await turnRelay?.handleOwnerInput(text)) ?? false;
						},
					},
					onRelay,
					onActivity: () => {
						lastActivityAt = Date.now();
					},
					// Protocol-native targets (ai-ezio) expose onTurnFinished and have no
					// PTY to buffer/echo keystrokes — line-buffer operator input so a typed
					// line submits as one turn on Enter instead of one turn per character.
					lineBufferedInput:
						typeof interactiveSession.onTurnFinished === "function",
				});

				// Start the live session — this launches the provider in the current terminal.
				await liveSession.start();
				liveSessionStarted = true;

				// Only now consume the claim and flip the binding to "bound".
				resolvedClaim = input.broker.control.completeAttachClaim({
					claimId: input.claimId,
					secret: input.secret,
					sessionId,
					provider: provider.getIdentity(),
					capabilities: provider.getCapabilities(),
					now: new Date().toISOString(),
					bindingSource: "mounted",
				});

				relayPaneWriter = createRelayPaneWriter({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
				});

				// The turn-event path is enabled for THIS mount only when the rollout
				// flag/env enabled it AND the target is a PTY provider (claude/codex).
				const eventPathEnabled =
					_eventEnabled &&
					(input.target === "claude" || input.target === "codex");
				turnRelay = (input.createTurnRelay ?? createMountedTurnOwnedRelay)({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
					currentAgent: input.target,
					// Safe even when the workspace path does not exist on disk (only
					// event-enabled / ezio mounts consume this id; production always has a
					// real workspace root). workspaceIdFromPath realpaths, which throws on
					// a missing path — degrade to "" rather than failing the mount.
					workspaceId: (() => {
						try {
							return workspaceIdFromPath(input.workspaceRoot);
						} catch {
							return "";
						}
					})(),
					eventPathEnabled,
					writeLocalMessage: (text) => interactiveSession.sendLocalMessage(text),
					writeUserInput: (text) => writeInjectedInput("mounted-inject", text),
					submitUserInput: submitInjectedInput,
					isPausedInput: () => liveSession?.isPaused() ?? false,
					onHandoffAccepted: () => {
						lastActivityAt = Date.now();
					},
					openComposer: async (args) => {
						const runComposer = async () => {
							const lineReader = createLocalModalLineReader({
								stdin: process.stdin,
								stdout: process.stdout,
							});
							closeLineReader = lineReader.close;
							const composer = createLocalMultilineComposer({
								prompt: args.prompt,
								initialValue: args.initialValue,
								writeLocalMessage: (text) => interactiveSession.sendLocalMessage(text),
								readLine: lineReader.readLine,
							});
							try {
								return await composer.run();
							} finally {
								lineReader.close();
								closeLineReader = () => {};
							}
						};
						if (liveSession?.withPausedInput) {
							return liveSession.withPausedInput(runComposer);
						}
						return runComposer();
					},
					captureHandbackText: async (turnText: string) => {
						if (!resolvedClaim) return null;
						const db = openDatabase(getSharedSqlitePath());
						try {
							// Serialize the /copy capture host-wide via the capture lease so
							// the pbpaste read is provably this collab's own output, and
							// detect human ⌘C interference via changeCount. Returns a
							// structured result the relay consumes (captured vs degraded).
							return await runLeasedCapture({
								db,
								collabId: resolvedClaim.collabId,
								pid: process.pid,
								turnText,
								readChangeCount,
								copySignature,
								runCapture: () =>
									captureClipboardHandback({
										triggerCopy: () => submitInjectedInput("/copy"),
										// Some provider versions show a picker after /copy (e.g. Claude
										// Code's content-type picker). Send Enter to confirm the default
										// selection if the clipboard has not changed yet after the delay.
										confirmPicker: () => {
											writeInjectedInput("mounted-submit-picker", "\r");
										},
										triggerDelayMs: 300,
									}),
							});
						} finally {
							db.close();
						}
					},
					confirmHandbackCapture: async () => {
						const runConfirm = async () => {
							const confirm = createLocalModalConfirm({
								stdin: process.stdin,
								stdout: process.stdout,
								message:
									"[ai-whisper] Response copied, Enter to hand back or Esc to cancel.",
							});
							return confirm.run();
						};
						if (liveSession?.withPausedInput) {
							return liveSession.withPausedInput(runConfirm);
						}
						return runConfirm();
					},
					prefillHandbackFromCapture: false,
					turnCapture,
					autoHandbackMaxAttempts: resolvePositiveIntEnv(
						"AI_WHISPER_AUTO_HANDBACK_MAX_ATTEMPTS",
					),
					autoHandbackRetryMs: resolvePositiveIntEnv(
						"AI_WHISPER_AUTO_HANDBACK_RETRY_MS",
					),
					// Protocol-native providers (ai-ezio) expose onTurnFinished; for them
					// the quiescence /copy auto-handback is skipped (handback comes from
					// the explicit idle event). Event-enabled claude/codex ALSO suppress it
					// by default — the turn-event path drives /copy via checkIdleActions's
					// settle → consume-armed → no-event-grace consult, falling back to /copy
					// only for indeterminate / fidelity-exhaustion / no-event cases, never a
					// positive mismatch (the no-false-handback contract). Auto-ACCEPT still runs.
					suppressQuiescenceHandback:
						typeof interactiveSession.onTurnFinished === "function" ||
						eventPathEnabled,
				});
				const mountedTurnRelay = turnRelay;

				// Turn-event listener: only for claude/codex when event path is enabled.
				// Starts the unix-socket server that receives shim-forwarded payloads and
				// routes them to the relay's handleTurnEvent. No-op when eventEnabled is false.
				if (
					eventPathEnabled &&
					(input.target === "claude" || input.target === "codex")
				) {
					const capturedRelay = mountedTurnRelay;
					turnEventListener = await (input.createTurnEventListener ??
						createTurnEventListener)({
						socketsDir: getStateSocketsDir(),
						workspaceId: workspaceIdFromPath(input.workspaceRoot),
						provider: input.target,
						onEvent: (e) => void capturedRelay.handleTurnEvent(e),
					});
				}

				// Protocol-native handback: on the explicit turn-complete event, deliver
				// the authoritative content straight to the original sender.
				interactiveSession.onTurnFinished?.((content) => {
					void mountedTurnRelay.handbackResolvedContent(content);
				});

				// Persist ezio's turn-fidelity decisions (reject/defer/deliver) as
				// relay_turn_event_diagnostics rows so the 2026-06-10 drafting-notes
				// path leaves a queryable audit trail in the REAL mount (spec §4.3/§7).
				// Byte/PTY providers omit onFidelityDecision (their decisions flow
				// through the relay gate), so this is a no-op for claude/codex.
				interactiveSession.onFidelityDecision?.((decision) => {
					mountedTurnRelay.recordEzioFidelityDecision(decision);
				});

				// Degrade if the provider exits unexpectedly (e.g. user Ctrl+C inside the provider,
				// or provider crashes). stop() is idempotent via the `stopping` guard.
					interactiveSession.onExit(() => {
							void (async () => {
								if (resolvedClaim) {
									mountedTurnRelay.handleOwnerDisconnect();
								}
								await stop();
								process.exit(0);
						})();
					});

					ownerRefreshTimer = setInterval(() => {
						void (async () => {
							mountedTurnRelay.refreshOwnerView();
							// Pass the real idle-elapsed clock so the relay's no-event grace
							// fallback (noEventFallbackDue) can fire in production — without it
							// the suppressed /copy path would never run and a dropped event
							// would halt the workflow.
							const idleElapsedMs = Date.now() - lastActivityAt;
							if (idleElapsedMs >= idleThresholdMs) {
								await mountedTurnRelay.checkIdleActions(idleElapsedMs);
							}
						})();
					}, 1000);
					mountedTurnRelay.refreshOwnerView();

				// Record session_attachment(kind='mounted') in the shared DB.
				try {
					recordMountedSession({
						cwd: input.workspaceRoot,
						agentType: input.target,
						ttyPath: input.ttyPath,
						pid: process.pid,
						collabIdOverride: resolvedClaim.collabId,
					});
				} catch {
					// Best-effort; shared-DB write failures must not break mount flow.
				}

				// Reap superseded session rows for this (collab, agent), keeping the
				// just-activated session. Belt-and-suspenders with the read-path fix
				// so the dashboard never resolves a stale prior-mount row (Bug A).
				reapStaleSessionsOnMount({
					collabId: resolvedClaim.collabId,
					agentType: input.target,
					keepSessionId: resolvedClaim.sessionId,
				});

				// Clear recovery state if this was a reconnect after recovery and
				// no other sessions remain degraded.
				try {
					const collabId = resolvedClaim.collabId;
					const remainingDegraded = input.broker.control
						.listSessionBindings(collabId)
						.some((b) => {
							if (!b.activeSessionId) return false;
							const s = input.broker.control
								.listSessions(collabId)
								.find((sess) => sess.sessionId === b.activeSessionId);
							return s?.healthState !== "healthy";
						});
					if (!remainingDegraded) {
						const db = openDatabase(getSharedSqlitePath());
						try {
							const current = getRecoveryState(db, collabId);
							if (current && current.state === "recovered") {
								upsertRecoveryState(db, {
									collabId,
									state: "normal",
									idleAfterRecovery: false,
									recoveredAt: null,
								});
							}
						} finally {
							db.close();
						}
					}
				} catch {
					// Best-effort recovery latch clear.
				}

				stopLoop = await (input.runLoop ?? runCompanionAgentLoop)({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
					sessionId: resolvedClaim.sessionId,
					provider,
					interactiveSession,
					relayPaneWriter,
				});
			} catch (err) {
				await stopLoop();
				if (liveSessionStarted && liveSession) {
					await liveSession.stop();
				}
				await input.broker.stop();
				throw err;
			}
		},
	};
}
