import type { relayTargets } from "./relay-host.js";

export type InteractiveSessionTarget = (typeof relayTargets)[number];

/** A turn-fidelity decision emitted by a protocol-native session's handback
 *  handler (spec §4.3). The mount wires these to the relay so every
 *  rejection/deferral/delivery is persisted as a `relay_turn_event_diagnostics`
 *  row — the same audit trail claude/codex turn events produce. */
export type TurnFidelityDecision = {
	action: "rejected_mid_composition" | "deferred_rearmed" | "delivered";
	verdict: "clean" | "mid_composition" | "empty" | "superseded";
	/** The candidate turn's content. Retained so a rejected mid-composition
	 *  candidate's exact drafting fragment is queryable after the fact via the
	 *  diagnostics row's message sample (spec §4.3/§7) — e.g. the 2026-06-10
	 *  "Let's draft" fragment. */
	content: string;
};

export interface InteractiveSessionController {
	start(): Promise<void>;
	stop(): Promise<void>;
	writeUserInput(data: string): void;
	sendLocalMessage(message: string): void;
	resize?(cols: number, rows: number): void;
	onExit(handler: () => void): void;
	onProviderOutput?(handler: (data: string) => void): void;
	/** Protocol-native providers (ai-ezio) fire this on an explicit turn-complete
	 *  event, passing the authoritative handback content. Byte/PTY providers omit
	 *  it and rely on output-quiescence detection instead. */
	onTurnFinished?(handler: (content: string) => void): void;
	/** Protocol-native providers (ai-ezio) emit a turn-fidelity decision per
	 *  candidate turn (reject mid-composition / defer / deliver, spec §4.3). The
	 *  mount registers a handler that records each as a diagnostics row. Byte/PTY
	 *  providers omit it (their fidelity decisions flow through the relay gate). */
	onFidelityDecision?(handler: (decision: TurnFidelityDecision) => void): void;
	/** Protocol-native providers (ai-ezio) cancel the in-flight turn (engine-level
	 *  interrupt). A no-op at the engine when no turn is running. Byte/PTY providers
	 *  omit it — Ctrl+C is forwarded to the spawned agent's own tty instead. */
	interrupt?(): void;
	/** Protocol-native providers (ai-ezio) re-render a just-submitted operator
	 *  line as hax's magenta `▌ ` stripe. The line-buffered input runtime erases
	 *  its plain echo and calls this with the submitted text + current tty width
	 *  so the wrap matches the editor. Omitted by byte/PTY providers (the spawned
	 *  agent paints its own input). */
	echoUserInput?(text: string, cols: number): void;
	/** Protocol-native providers (ai-ezio) try to handle an operator-typed line
	 *  as a local session command (e.g. /compact). Returns true when consumed
	 *  (handled and rendered locally — the host must NOT submit it as a turn),
	 *  false for ordinary input. PTY providers (claude/codex) omit it, so their
	 *  slashes pass through to the spawned agent. Called ONLY from the operator
	 *  line-input hook — never from relayed/injected input. */
	tryConsumeLocalCommand?(line: string): Promise<boolean>;
}
