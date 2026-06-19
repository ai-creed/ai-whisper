import type {
	InteractiveSessionController,
	OverlayRunner,
	TurnFidelityDecision,
} from "@ai-whisper/shared";
import type {
	AssistantTurnFinishedEvent,
	ProtocolEvent,
} from "@ai-ezio/protocol";
import {
	callHostRehydration,
	loadMcpHost,
	type McpHost,
} from "@ai-ezio/mcp-host";
import {
	createAutoCompactDriver,
	createRenameController,
	createSessionTitleStore,
	loadConfig,
	resolveHaxBinary,
	type AutoCompactDriver,
	type CompactorSession,
	type SessionTitleStore,
} from "@ai-ezio/harness";
import {
	defaultCreateEngineSession,
	type AiEzioEngineSession,
	type CreateEngineSession,
} from "./ai-ezio-engine.js";
import {
	createMountedRenderer,
	runResumeFlow,
	SlashController,
	type SlashContext,
	makeClipboard,
	discoverSkills,
	nodeSkillFs,
	showTranscript as renderTranscript,
	type SkillEnv,
} from "@ai-ezio/surface";
import { isMidCompositionShape } from "./mid-composition-shape.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The turn-fidelity outcome the handback handler emits per candidate turn
 * (spec §4.3). Wired by the mount to `relay.recordTurnEventDiagnostic` so ezio's
 * decisions land in the same `relay_turn_event_diagnostics` table as
 * claude/codex. */
export type EzioFidelityDecision = TurnFidelityDecision;

/** Builds the auto-compaction driver for this session. Injectable for tests;
 * the default wires the SAME shared harness driver the standalone CLI uses. */
export type BuildAutoCompact = (deps: {
	session: AiEzioEngineSession;
	host: McpHost;
	write: (s: string) => void;
}) => AutoCompactDriver | null;

/** Default: the shared `createAutoCompactDriver`, with mounted chrome written
 * straight to the pane and the same cortex rehydration the standalone CLI uses
 * (so a compacted summary still carries the carried-forward project memory).
 * Mounted mode has no session recorder, so there is no deterministic digest
 * fallback — a failed summarize aborts and re-arms (the harness Compactor's own
 * policy). The real Session exposes `runExclusive` even though the narrowed
 * engine facet does not advertise it. */
const defaultBuildAutoCompact: BuildAutoCompact = ({
	session,
	host,
	write,
}) => {
	const { compaction } = loadConfig();
	return createAutoCompactDriver({
		session: session as unknown as CompactorSession,
		config: compaction,
		// rehydrate is an exact-optional property: omit it entirely (rather than
		// pass `undefined`) when cortex rehydration is disabled.
		...(compaction.rehydrate
			? { rehydrate: () => callHostRehydration(host) }
			: {}),
		onCycleStart: () => write("compacting…\r\n"),
		onNote: (line: string) => write(`${line}\r\n`),
	});
};

export function createAiEzioLiveSession(input: {
	stdout: NodeJS.WritableStream;
	createEngineSession?: CreateEngineSession;
	/** Injectable MCP host (tests); defaults to loadMcpHost from mcp.json. The
	 * SAME factory the standalone CLI uses — this is what gives mounted ezio MCP
	 * tools (M9). */
	mcpHost?: McpHost;
	/** Injectable auto-compaction driver builder (tests); defaults to the shared
	 * harness driver. This is the wiring that was missing in mounted mode — the
	 * standalone CLI fed usage + fired auto-compaction, the adapter never did. */
	buildAutoCompact?: BuildAutoCompact;
	/** Injectable OS-clipboard writer for mounted /copy (tests); defaults to the
	 * platform clipboard (pbcopy / wl-copy / xclip) via @ai-ezio/surface. */
	clipboard?: (text: string) => Promise<void>;
	/** Per-mode interactive overlay runner (mounted: wired from liveSession).
	 * If absent, /resume prints "resume unavailable in this host". */
	runInteractiveOverlay?: OverlayRunner;
	/** Test seam: defaults to createSessionTitleStore(). */
	titleStore?: SessionTitleStore;
	/** Test seam: defaults to spawning `hax --list-sessions`. */
	listSessions?: () => Promise<string>;
	/** Test seam: defaults to () => Date.now() (picker relative-time). */
	now?: () => number;
}): InteractiveSessionController {
	const create = input.createEngineSession ?? defaultCreateEngineSession;
	const buildCompact = input.buildAutoCompact ?? defaultBuildAutoCompact;
	// Mounted posture: confirm degrades to deny (no human to prompt in a pane).
	// cwd = the mounted process's workspace, from which cortex derives the repo.
	const host =
		input.mcpHost ?? loadMcpHost({ mode: "mounted", cwd: process.cwd() });

	// §1C title store + rename controller — built before start() so the seam is
	// available to tests that construct but do not start the adapter.
	const titleStore = input.titleStore ?? createSessionTitleStore();
	// listSessions: injectable seam; defaults to spawning the engine's --list-sessions.
	const listSessions =
		input.listSessions ??
		((): Promise<string> =>
			new Promise((resolve) => {
				let out = "";
				const child = spawn(resolveHaxBinary(), ["--list-sessions"], {
					cwd: process.cwd(),
					stdio: ["ignore", "pipe", "ignore"],
				});
				child.stdout?.on("data", (d: Buffer) => void (out += d.toString("utf8")));
				child.on("error", () => resolve("[]"));
				child.on("exit", (code) => resolve(code === 0 ? out : "[]"));
			}));

	let session: AiEzioEngineSession | null = null;
	let driver: AutoCompactDriver | null = null;
	let sawTurn = false; // guards against the startup idle firing a handback
	// Settle-on-last (spec §4.3): the last finished-turn content awaiting a
	// genuine idle. A newer assistant_turn_finished supersedes an older candidate
	// before idle settles, so a transient idle between a drafting turn and the
	// real answer never relays the drafting turn.
	let pendingContent: string | null = null;
	// Mounted slash-command state (Task 7): the last finished turn's content +
	// usage, tracked off the event stream for /copy and /usage. The controller is
	// built in start() once the session + driver exist; null until then.
	let lastContent = "";
	let lastUsage: AssistantTurnFinishedEvent["usage"] | undefined;
	let slash: SlashController | null = null;
	// Busy flag: true while an assistant turn is in flight.
	let inTurn = false;

	const outputHandlers: Array<(data: string) => void> = [];
	const turnFinishedHandlers: Array<(content: string) => void> = [];
	const fidelityDecisionHandlers: Array<
		(decision: TurnFidelityDecision) => void
	> = [];
	const exitHandlers: Array<() => void> = [];

	// M8: all pane presentation (banner / spinner / markdown-at-turn-end / tool
	// calls / usage / prompt / errors) lives in the mounted renderer. The engine
	// stays protocol-native — the renderer reconstructs the hax REPL look from
	// events alone (no PTY, no scraping). This session keeps only its
	// InteractiveSessionController duties: handler forwarding, M6 handback timing,
	// and submit — and delegates every byte of display to the renderer.
	const renderer = createMountedRenderer({ stdout: input.stdout });

	// §1C rename controller — feeds protocol events to track the live session id.
	const rename = createRenameController({
		store: titleStore,
		// Deferred for the same reason as standalone: noteEvent runs inside the
		// onEvent tee before the event reaches waiters; queueMicrotask runs status()
		// after the settling idle is routed to the in-flight turn.
		requestStatus: () => queueMicrotask(() => void session?.status().catch(() => {})),
	});

	const onEvent = (event: ProtocolEvent) => {
		// Feed the rename controller FIRST — it must see every event (including
		// during compaction) so the id stays fresh across compaction cycles.
		rename.noteEvent(event);

		// While an auto-compaction cycle runs, its injected summarize turn must be
		// invisible: never relayed as a handback and never drawn in the pane (the
		// driver's onCycleStart/onNote show the compacting chrome instead). The
		// MCP host stays live so the protocol never deadlocks mid-cycle.
		const compacting = driver?.compacting() ?? false;
		// 1) Session responsibilities — forward to handlers BEFORE the renderer
		//    draws the prompt, preserving M6 handback timing. Raw deltas are
		//    forwarded to onProviderOutput (relay capture) even though the pane
		//    suppresses them (markdown renders from the final content instead).
		if (!compacting)
			switch (event.type) {
				case "assistant_delta":
					sawTurn = true;
					for (const h of outputHandlers) h(event.text);
					break;
				case "assistant_turn_started":
					inTurn = true;
					break;
				case "assistant_turn_finished":
					sawTurn = true;
					// Task 7: track the authoritative last-turn content + usage for the
					// mounted /copy and /usage slash commands (off the event stream, so
					// the slash path never re-derives them from pane chrome).
					lastContent = event.content;
					lastUsage = event.usage;
					// Re-arm on each completion: a newer turn supersedes an older
					// candidate that has not yet settled into a genuine idle. If a
					// prior candidate is still pending here, the new completion arrived
					// before idle settled — log the supersession so it is not silent.
					if (pendingContent !== null) {
						const superseded = pendingContent;
						for (const h of fidelityDecisionHandlers)
							h({
								action: "deferred_rearmed",
								verdict: "superseded",
								content: superseded,
							});
					}
					pendingContent = event.content;
					break;
				case "idle":
					// Settle the in-turn busy flag on the settling idle (outside compaction).
					inTurn = false;
					if (sawTurn && pendingContent !== null) {
						const candidate = pendingContent;
						// Shape guard (spec §4.3): never relay a drafting/empty fragment.
						// A rejected candidate defers — the next real turn replaces it —
						// instead of being delivered and forcing an evaluator halt.
						if (isMidCompositionShape(candidate)) {
							for (const h of fidelityDecisionHandlers)
								h({
									action: "rejected_mid_composition",
									verdict:
										candidate.trim().length === 0 ? "empty" : "mid_composition",
									content: candidate,
								});
							pendingContent = null;
							sawTurn = false;
							break;
						}
						pendingContent = null;
						sawTurn = false;
						for (const h of fidelityDecisionHandlers)
							h({ action: "delivered", verdict: "clean", content: candidate });
						for (const h of turnFinishedHandlers) h(candidate);
					}
					break;
				default:
					break;
			}
		// 2) MCP host — services delegated tool calls (tool_call_requested →
		//    sendToolResult). No-op for non-delegated events.
		void host.handleEvent(event);
		// 3) Display — the renderer owns all pane output; suppressed for the
		//    summarize turn so the cycle never bleeds into the transcript.
		if (!compacting) renderer.handle(event);
		// 4) Auto-compaction — fed AFTER the handback so a real turn always
		//    relays before its own idle fires a cycle. Finished turns feed the
		//    usage signal; idle is the trigger point for an armed compaction.
		driver?.handleEvent(event);
	};

	return {
		async start() {
			session = create({ onEvent });
			// Build the driver before start() so the very first turn's usage and
			// idle are observed. onEvent closes over `driver`; startup events
			// (ready/status) are ignored by the driver until a turn finishes.
			driver = buildCompact({
				session,
				host,
				write: (s) => input.stdout.write(s),
			});
			session.onExit(() => {
				for (const h of exitHandlers) h();
			});
			// Mint a per-process HAX_TRANSCRIPT mirror so the mounted /transcript view
			// has a file to dump. The harness Session writes the model-perspective
			// transcript here when started with transcriptPath.
			const transcriptPath = join(
				tmpdir(),
				`ezio-mounted-${randomUUID()}.txt`,
			);
			await session.start({ transcriptPath });
			// Register delegated (MCP) tools BEFORE any submit, so the first turn
			// sees them. Same loadMcpHost factory + host.start sequence as standalone.
			await host.start(session);
			// Build the mounted SlashController now that the session + driver exist.
			// /quit is excluded (which also drops its /exit alias) — mounted mode owns
			// the lifecycle, so quitting the pane is not a slash concern. Output is
			// rendered straight to the pane's stdout; /transcript dumps inline (no
			// pager) since the pane is not an interactive TTY for paging.
			const skillEnv: SkillEnv = {
				cwd: process.cwd(),
				home: process.env.HOME ?? "",
				xdgConfigHome: process.env.XDG_CONFIG_HOME,
			};
			const skillFs = nodeSkillFs();
			const sessionFacet = session;

			// Resume thunk — wraps runResumeFlow with the mounted-specific primitives.
			const resumeThunk = () =>
				runResumeFlow({
					write: (s) => input.stdout.write(s),
					isBusy: () => inTurn,
					listSessions,
					titles: () => titleStore.loadTitles(),
					currentSessionId: () => rename.currentSessionId(),
					runOverlay: async (run) => {
						if (!input.runInteractiveOverlay) {
							input.stdout.write("resume unavailable in this host\n");
							return;
						}
						await input.runInteractiveOverlay(run);
					},
					resume: async (id) => {
						if (sessionFacet.transcriptPath !== undefined) {
							await session!.resume(id, { transcriptPath: sessionFacet.transcriptPath });
						} else {
							await session!.resume(id);
						}
						await host.start(session!); // re-register MCP delegated tools
						// Re-render the mounted banner on the post-respawn ready event
						// (renderer.handle receives the new ready from onEvent).
					},
					// Spec §4: a failed respawn leaves the engine closed — report (in
					// runResumeFlow) and exit cleanly. Firing the adapter's exit handlers is
					// the "normal engine-exit path" for a mounted pane.
					onFatal: () => {
						for (const h of exitHandlers) h();
					},
					now: input.now ?? (() => Date.now()),
				});

			const slashCtx: SlashContext = {
				write: (s) => input.stdout.write(s),
				session: {
					newConversation: async () => {
						await sessionFacet.newConversation();
						rename.noteNewConversation();
					},
					status: () => sessionFacet.status(),
				},
				...(driver
					? { compactor: { compactNow: () => driver!.compactNow() } }
					: {}),
				lastContent: () => lastContent,
				lastUsage: () => lastUsage,
				skills: () =>
					discoverSkills(skillEnv, skillFs).map((s) => ({
						name: s.name,
						source: s.source,
						description: s.description,
					})),
				clipboard: input.clipboard ?? makeClipboard(process.platform, spawn),
				showTranscript: () =>
					renderTranscript({
						path: sessionFacet.transcriptPath ?? "",
						readText: (p) => {
							try {
								return readFileSync(p, "utf8");
							} catch {
								return undefined;
							}
						},
						interactive: false,
						spawnPager: () => Promise.resolve(),
						suspendRaw: () => {},
						restoreRaw: () => {},
						write: (s) => input.stdout.write(s),
					}),
				currentSessionId: () => rename.currentSessionId(),
				getSessionTitle: () => rename.getSessionTitle(),
				setSessionTitle: (t) => rename.setSessionTitle(t),
				resume: resumeThunk,
			};
			slash = new SlashController(slashCtx, { excludeCommands: ["quit"] });
		},
		async stop() {
			await host.stop();
			session?.close();
			session = null;
		},
		writeUserInput(data: string) {
			// Protocol-native: one submit, no keystream, no trailing CR.
			// Mark busy AT SUBMIT — not later on `assistant_turn_started`. The engine's
			// turn gate is held the moment submit lands, so without this a `/resume`
			// entered in the post-submit / pre-`assistant_turn_started` window (e.g. a
			// pasted "foo\n/resume\n") would slip past the isBusy() guard. The settling
			// `idle` clears it. (Session.resume's EngineBusyError is the backstop.)
			inTurn = true;
			session?.submit(data);
		},
		interrupt() {
			// Cancel the in-flight turn over the protocol; the engine ignores it
			// when no turn is running, so a stray Ctrl+C at idle is harmless.
			session?.interrupt();
		},
		async tryConsumeLocalCommand(line: string): Promise<boolean> {
			// Mounted ezio handles `/`-commands locally (rendered to the pane) so they
			// never reach the headless hax engine. A handled/unknown command is
			// consumed (true); ordinary text and the would-be /quit lifecycle fall
			// through to a submit outcome, which we report as not-consumed.
			if (!slash) return false;
			const outcome = await slash.handle(line);
			return outcome.action !== "submit";
		},
		echoUserInput(text: string, cols: number) {
			// hax-style magenta `▌ ` echo of the submitted line. The runtime erases
			// its plain local echo before calling this; we just paint the stripe.
			renderer.echoUserInput(text, cols);
		},
		sendLocalMessage(message: string) {
			// Local control text (relay preview) — surface to the operator's stdout.
			input.stdout.write(message);
		},
		onExit(handler: () => void) {
			exitHandlers.push(handler);
		},
		onProviderOutput(handler: (data: string) => void) {
			outputHandlers.push(handler);
		},
		onTurnFinished(handler: (content: string) => void) {
			turnFinishedHandlers.push(handler);
		},
		onFidelityDecision(handler: (decision: TurnFidelityDecision) => void) {
			fidelityDecisionHandlers.push(handler);
		},
	};
}
