import type { relayTargets } from "./relay-host.js";

export type InteractiveSessionTarget = (typeof relayTargets)[number];

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
	/** Protocol-native providers (ai-ezio) re-render a just-submitted operator
	 *  line as hax's magenta `▌ ` stripe. The line-buffered input runtime erases
	 *  its plain echo and calls this with the submitted text + current tty width
	 *  so the wrap matches the editor. Omitted by byte/PTY providers (the spawned
	 *  agent paints its own input). */
	echoUserInput?(text: string, cols: number): void;
}
