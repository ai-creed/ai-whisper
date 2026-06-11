import type { InteractiveSessionController } from "@ai-whisper/shared";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { loadMcpHost, type McpHost } from "@ai-ezio/mcp-host";
import {
	defaultCreateEngineSession,
	type AiEzioEngineSession,
	type CreateEngineSession,
} from "./ai-ezio-engine.js";
import { createMountedRenderer } from "@ai-ezio/surface";
import { isMidCompositionShape } from "./mid-composition-shape.js";

/** The turn-fidelity outcome the handback handler emits per candidate turn
 * (spec §4.3). Wired by the mount to `relay.recordTurnEventDiagnostic` so ezio's
 * decisions land in the same `relay_turn_event_diagnostics` table as
 * claude/codex. */
export type EzioFidelityDecision = {
	action: "rejected_mid_composition" | "deferred_rearmed" | "delivered";
	verdict: "clean" | "mid_composition" | "empty" | "superseded";
};

export function createAiEzioLiveSession(input: {
	stdout: NodeJS.WritableStream;
	createEngineSession?: CreateEngineSession;
	/** Injectable MCP host (tests); defaults to loadMcpHost from mcp.json. The
	 * SAME factory the standalone CLI uses — this is what gives mounted ezio MCP
	 * tools (M9). */
	mcpHost?: McpHost;
	/** Optional sink for turn-fidelity decisions (spec §4.3). The mount wires this
	 * to `relay.recordTurnEventDiagnostic({ provider: "ezio", ... })` so every
	 * rejection/deferral/delivery is logged, not silent. */
	onFidelityDecision?: (decision: EzioFidelityDecision) => void;
}): InteractiveSessionController {
	const create = input.createEngineSession ?? defaultCreateEngineSession;
	// Mounted posture: confirm degrades to deny (no human to prompt in a pane).
	// cwd = the mounted process's workspace, from which cortex derives the repo.
	const host =
		input.mcpHost ?? loadMcpHost({ mode: "mounted", cwd: process.cwd() });

	let session: AiEzioEngineSession | null = null;
	let lastContent = "";
	let sawTurn = false; // guards against the startup idle firing a handback
	// Settle-on-last (spec §4.3): the last finished-turn content awaiting a
	// genuine idle. A newer assistant_turn_finished supersedes an older candidate
	// before idle settles, so a transient idle between a drafting turn and the
	// real answer never relays the drafting turn.
	let pendingContent: string | null = null;

	const outputHandlers: Array<(data: string) => void> = [];
	const turnFinishedHandlers: Array<(content: string) => void> = [];
	const exitHandlers: Array<() => void> = [];

	// M8: all pane presentation (banner / spinner / markdown-at-turn-end / tool
	// calls / usage / prompt / errors) lives in the mounted renderer. The engine
	// stays protocol-native — the renderer reconstructs the hax REPL look from
	// events alone (no PTY, no scraping). This session keeps only its
	// InteractiveSessionController duties: handler forwarding, M6 handback timing,
	// and submit — and delegates every byte of display to the renderer.
	const renderer = createMountedRenderer({ stdout: input.stdout });

	const onEvent = (event: ProtocolEvent) => {
		// 1) Session responsibilities — forward to handlers BEFORE the renderer
		//    draws the prompt, preserving M6 handback timing. Raw deltas are
		//    forwarded to onProviderOutput (relay capture) even though the pane
		//    suppresses them (markdown renders from the final content instead).
		switch (event.type) {
			case "assistant_delta":
				sawTurn = true;
				for (const h of outputHandlers) h(event.text);
				break;
			case "assistant_turn_finished":
				sawTurn = true;
				lastContent = event.content;
				// Re-arm on each completion: a newer turn supersedes an older
				// candidate that has not yet settled into a genuine idle. If a
				// prior candidate is still pending here, the new completion arrived
				// before idle settled — log the supersession so it is not silent.
				if (pendingContent !== null) {
					input.onFidelityDecision?.({
						action: "deferred_rearmed",
						verdict: "superseded",
					});
				}
				pendingContent = event.content;
				break;
			case "idle":
				if (sawTurn && pendingContent !== null) {
					const candidate = pendingContent;
					// Shape guard (spec §4.3): never relay a drafting/empty fragment.
					// A rejected candidate defers — the next real turn replaces it —
					// instead of being delivered and forcing an evaluator halt.
					if (isMidCompositionShape(candidate)) {
						input.onFidelityDecision?.({
							action: "rejected_mid_composition",
							verdict: candidate.trim().length === 0 ? "empty" : "mid_composition",
						});
						pendingContent = null;
						lastContent = "";
						sawTurn = false;
						break;
					}
					pendingContent = null;
					lastContent = "";
					sawTurn = false;
					input.onFidelityDecision?.({ action: "delivered", verdict: "clean" });
					for (const h of turnFinishedHandlers) h(candidate);
				}
				break;
			default:
				break;
		}
		// 2) MCP host — services delegated tool calls (tool_call_requested →
		//    sendToolResult). No-op for non-delegated events.
		void host.handleEvent(event);
		// 3) Display — the renderer owns all pane output.
		renderer.handle(event);
	};

	return {
		async start() {
			session = create({ onEvent });
			session.onExit(() => {
				for (const h of exitHandlers) h();
			});
			await session.start();
			// Register delegated (MCP) tools BEFORE any submit, so the first turn
			// sees them. Same loadMcpHost factory + host.start sequence as standalone.
			await host.start(session);
		},
		async stop() {
			await host.stop();
			session?.close();
			session = null;
		},
		writeUserInput(data: string) {
			// Protocol-native: one submit, no keystream, no trailing CR.
			session?.submit(data);
		},
		interrupt() {
			// Cancel the in-flight turn over the protocol; the engine ignores it
			// when no turn is running, so a stray Ctrl+C at idle is harmless.
			session?.interrupt();
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
	};
}
