import type { InteractiveSessionController } from "@ai-whisper/shared";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import {
	defaultCreateEngineSession,
	type AiEzioEngineSession,
	type CreateEngineSession,
} from "./ai-ezio-engine.js";
import { createMountedRenderer } from "./mounted-renderer.js";

export function createAiEzioLiveSession(input: {
	stdout: NodeJS.WritableStream;
	createEngineSession?: CreateEngineSession;
}): InteractiveSessionController {
	const create = input.createEngineSession ?? defaultCreateEngineSession;

	let session: AiEzioEngineSession | null = null;
	let lastContent = "";
	let sawTurn = false; // guards against the startup idle firing a handback

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
				break;
			case "idle":
				if (sawTurn) {
					const content = lastContent;
					lastContent = "";
					sawTurn = false;
					for (const h of turnFinishedHandlers) h(content);
				}
				break;
			default:
				break;
		}
		// 2) Display — the renderer owns all pane output.
		renderer.handle(event);
	};

	return {
		async start() {
			session = create({ onEvent });
			session.onExit(() => {
				for (const h of exitHandlers) h();
			});
			await session.start();
		},
		// async to satisfy InteractiveSessionController.stop(): Promise<void>; the
		// protocol close is synchronous.
		// eslint-disable-next-line @typescript-eslint/require-await
		async stop() {
			session?.close();
			session = null;
		},
		writeUserInput(data: string) {
			// Protocol-native: one submit, no keystream, no trailing CR.
			session?.submit(data);
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
