import type { AgentType } from "@ai-whisper/shared";
export type CodexSubmitStrategy = "bracketed" | "keystream" | "chunk";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export async function submitInjectedProviderInput(input: {
	target: AgentType;
	text: string;
	writeUserInput: (text: string) => void;
	sleep?: (ms: number) => Promise<void>;
	/** From the bracketed-paste detector: does codex currently have paste mode on?
	 *  Doubles as a readiness signal (composer focused). Defaults to false. */
	bracketedPasteEnabled?: boolean | undefined;
	/** Operator pin (AI_WHISPER_CODEX_SUBMIT_STRATEGY). Overrides auto-detection. */
	strategyOverride?: CodexSubmitStrategy | undefined;
}): Promise<void> {
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	if (input.target === "ezio") {
		// Protocol-native: the ai-ezio live session's writeUserInput maps to a
		// single session.submit(); no keystream, no separate carriage return.
		input.writeUserInput(input.text);
		return;
	}

	if (input.target === "claude" || input.target === "agy") {
		input.writeUserInput(input.text);
		await sleep(75);
		input.writeUserInput("\r");
		return;
	}

	// codex: pick the strategy. Override wins; otherwise use bracketed paste when
	// codex advertises paste mode (ESC[?2004h), else fall back to the keystream
	// drip. If codex ever drops bracketed paste, the detector reports false and
	// this auto-falls back to keystream with no code change.
	const strategy: CodexSubmitStrategy =
		input.strategyOverride ??
		(input.bracketedPasteEnabled ? "bracketed" : "keystream");

	if (strategy === "bracketed") {
		// Atomic bracketed paste: codex ingests the whole (possibly multi-line)
		// payload as one pasted block (newlines literal, no premature submit), then
		// a single \r on a separate beat submits it. Strip any embedded end-marker
		// so the payload cannot close the paste early.
		const safe = input.text.split(PASTE_END).join("");
		input.writeUserInput(PASTE_START + safe + PASTE_END);
		await sleep(100);
		input.writeUserInput("\r");
		return;
	}

	if (strategy === "chunk") {
		input.writeUserInput(input.text);
		await sleep(75);
		input.writeUserInput("\r");
		return;
	}

	// keystream (legacy fallback): codex has been least reliable when large chunks
	// are written at once without bracketed paste, so type a short keystream and
	// submit on a separate beat.
	for (const char of input.text) {
		input.writeUserInput(char);
		await sleep(5);
	}
	await sleep(100);
	input.writeUserInput("\r");
}
