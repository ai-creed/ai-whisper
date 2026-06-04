import type { InteractiveSessionController } from "@ai-whisper/shared";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import {
	defaultCreateEngineSession,
	type AiEzioEngineSession,
	type CreateEngineSession,
} from "./ai-ezio-engine.js";

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

	const onEvent = (event: ProtocolEvent) => {
		switch (event.type) {
			case "assistant_delta": {
				sawTurn = true;
				for (const h of outputHandlers) h(event.text);
				input.stdout.write(event.text);
				break;
			}
			case "assistant_turn_finished": {
				sawTurn = true;
				lastContent = event.content;
				break;
			}
			case "idle": {
				if (!sawTurn) break; // startup idle — nothing to hand back
				const content = lastContent;
				lastContent = "";
				sawTurn = false;
				for (const h of turnFinishedHandlers) h(content);
				break;
			}
			default:
				break;
		}
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
