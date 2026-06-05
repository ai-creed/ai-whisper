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

	// M7: re-create the hax REPL "look" from protocol events (engine stays
	// protocol-native — no PTY, no scraping). Banner once on `status`; a usage
	// line + `›` prompt after each turn.
	let lastUsage: Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"];
	let bannerRendered = false; // spec: render the banner ONCE

	// Mirrors hax's format_tokens (vendor/hax/src/agent.c) EXACTLY — binary k/M
	// with the same rounding: 595 -> "595", 8900 -> "8.7k", 262144 -> "256k".
	const fmtTokens = (n: number): string => {
		if (n < 0) return "?";
		if (n < 1024) return String(n);
		if (n < 10 * 1024) return `${(n / 1024).toFixed(1)}k`;
		if (n < 1024 * 1024) return `${Math.floor((n + 512) / 1024)}k`;
		if (n < 10 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
		return `${Math.floor((n + 512 * 1024) / (1024 * 1024))}M`;
	};

	const renderBanner = (provider: string, model: string, effort: string) => {
		const tail = effort ? `${provider} · ${model} · ${effort}` : `${provider} · ${model}`;
		input.stdout.write(`\u001b[36m▌\u001b[0m \u001b[1mezio\u001b[0m \u001b[2m› ${tail}\u001b[0m\n`);
	};

	const renderUsage = (
		u: NonNullable<Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"]>,
	) => {
		const parts: string[] = [];
		if (typeof u.contextTokens === "number") {
			let s = `context ${fmtTokens(u.contextTokens)}`;
			if (typeof u.contextLimit === "number" && u.contextLimit > 0)
				s += ` / ${fmtTokens(u.contextLimit)} (${Math.floor((u.contextTokens * 100) / u.contextLimit)}%)`;
			parts.push(s);
		}
		if (typeof u.outputTokens === "number") parts.push(`out ${fmtTokens(u.outputTokens)}`);
		if (typeof u.cachedTokens === "number" && u.cachedTokens > 0)
			parts.push(`cached ${fmtTokens(u.cachedTokens)}`);
		if (parts.length > 0) input.stdout.write(`\u001b[2m${parts.join(" · ")}\u001b[0m\n`);
	};

	const renderPrompt = () => input.stdout.write("\u001b[2m›\u001b[0m ");

	const onEvent = (event: ProtocolEvent) => {
		switch (event.type) {
			case "status": {
				// Render the banner ONCE (auto-emitted right after ready in mount
				// mode); a later M4 status control must not duplicate it.
				if (!bannerRendered) {
					renderBanner(event.provider, event.model, event.effort ?? "");
					bannerRendered = true;
				}
				break;
			}
			case "assistant_delta": {
				sawTurn = true;
				for (const h of outputHandlers) h(event.text);
				input.stdout.write(event.text);
				break;
			}
			case "assistant_turn_finished": {
				sawTurn = true;
				lastContent = event.content;
				lastUsage = event.usage;
				break;
			}
			case "idle": {
				if (!sawTurn) break; // startup idle — nothing to hand back
				const content = lastContent;
				lastContent = "";
				sawTurn = false;
				for (const h of turnFinishedHandlers) h(content);
				// Usage line + `›` prompt land after the turn's streamed text and
				// the handback, giving the pane a REPL look.
				if (lastUsage) renderUsage(lastUsage);
				lastUsage = undefined;
				renderPrompt();
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
