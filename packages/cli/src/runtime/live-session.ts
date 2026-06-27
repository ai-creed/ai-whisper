import type {
	InteractiveSessionController,
	OverlayIO,
	RelayDirective,
} from "@ai-whisper/shared";
import { appendFileSync } from "node:fs";
import {
	getRelayDirectiveError,
	parseRelayDirective,
} from "./relay-directive.js";
import { createRelayLineBuffer } from "./relay-line-buffer.js";
import { createBusyIndicator } from "./busy-indicator.js";
import type { createRelayPaneWriter } from "./relay-pane-writer.js";
import {
	normalizeTerminalInput,
	type NormalizedInputState,
} from "./terminal-input-normalizer.js";

const ORANGE_RELAY = "\u001b[38;5;215m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_LINE = "\r\u001b[2K";
// Cell width of the prompt (`❯ `) / submitted stripe (`▌ `): glyph + space. Used
// to count how many tty rows the plainly-echoed input occupied before re-paint.
const STRIPE_COLS = 2;
const FALLBACK_COLS = 80;
function toHex(text: string): string {
	return Buffer.from(text, "utf8").toString("hex");
}

function ttyCols(stdout: NodeJS.WritableStream): number {
	const cols = (stdout as Partial<NodeJS.WriteStream>).columns;
	return typeof cols === "number" && cols > 0 ? cols : FALLBACK_COLS;
}

export function createLiveSessionRuntime(input: {
	interactiveSession: InteractiveSessionController;
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
	onRelay: (
		directive: RelayDirective,
		sendNow: (message: string) => void,
	) => Promise<string | null>;
	onRelayCancel?: () => void;
	relayPaneWriter?: ReturnType<typeof createRelayPaneWriter> | undefined;
	externalInputGate?: {
		isBlocked(): boolean;
		renderBlockedMessage(): string;
		onCancel(): void;
	};
	externalInputRouter?: {
		handleInput(text: string): Promise<boolean> | boolean;
	};
	onActivity?: () => void;
	/**
	 * Protocol-native targets (ai-ezio) have no PTY to buffer/echo operator
	 * keystrokes, so without this each character is submitted as its own turn.
	 * When true, plain passthrough input is accumulated with local echo and
	 * submitted as a complete line on Enter (codex/claude PTY paths leave this
	 * false and keep raw char-by-char passthrough).
	 */
	lineBufferedInput?: boolean;
}) {
	const ttyStdin = input.stdin as NodeJS.ReadableStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	const previousRawMode = ttyStdin.isRaw;
	const canManageRawMode =
		ttyStdin.isTTY &&
		typeof ttyStdin.setRawMode === "function" &&
		!process.env.AI_WHISPER_ADOPTED_TTY;
	const debugLogPath = process.env.AI_WHISPER_DEBUG_INPUT_LOG;
	const busyIndicator = createBusyIndicator({
		write: (data) => input.interactiveSession.sendLocalMessage(data),
	});
	const lineBuffer = createRelayLineBuffer({
		getError: getRelayDirectiveError,
		isRelayDirective: (line) => parseRelayDirective(line) !== null,
		isRelayPrefix: (line) =>
			["@@codex", "@@claude", "@@ezio", "@@agy", "@@pull"].some(
				(target) => target.startsWith(line) || line.startsWith(target),
			),
	});
	let relayPreviewVisible = false;
	let inputState: NormalizedInputState = {};
	let pausedInputDepth = 0;
	// Overlay raw-key routing: while an overlay is active, the stdin `data`
	// handler enqueues chunks here instead of going through processChunk.
	let overlayPush: ((chunk: string) => void) | null = null;

	function setMountedRawMode(mode: boolean) {
		if (canManageRawMode) {
			ttyStdin.setRawMode?.(mode);
		}
	}

	function debug(event: Record<string, unknown>) {
		if (!debugLogPath) {
			return;
		}

		appendFileSync(
			debugLogPath,
			`${JSON.stringify({
				at: new Date().toISOString(),
				sessionId: process.env.AI_WHISPER_SESSION_ID ?? null,
				...event,
			})}\n`,
		);
	}

	function renderRelayPreview(line: string) {
		if (!line.startsWith("@@")) {
			clearRelayPreview();
			return;
		}

		relayPreviewVisible = true;
		input.interactiveSession.sendLocalMessage(
			`${CLEAR_LINE}${ORANGE_RELAY}${line}${ANSI_RESET}`,
		);
	}

	function clearRelayPreview() {
		if (!relayPreviewVisible) {
			return;
		}

		relayPreviewVisible = false;
		input.interactiveSession.sendLocalMessage(CLEAR_LINE);
	}

	// Line buffer for protocol-native targets (no PTY): accumulate plain input
	// with local echo, handle backspace, and submit the whole line on Enter.
	// Mirrors createLocalModalLineReader's local line-editing.
	let inputLineBuffer = "";
	async function feedLineBufferedInput(data: string) {
		for (const char of data) {
			if (char === "\u0003") {
				// Ctrl+C: with text typed, clear the line (hax-style); otherwise
				// interrupt the in-flight turn (a no-op at the engine when idle).
				// Raw mode means there is no SIGINT — we own this key.
				if (inputLineBuffer.length > 0) {
					input.stdout.write("\b \b".repeat(Array.from(inputLineBuffer).length));
					inputLineBuffer = "";
				} else {
					input.interactiveSession.interrupt?.();
				}
				continue;
			}
			if (char === "\u0004") {
				// Ctrl+D: exit the mounted session immediately. stop() closes the
				// engine, whose exit cascades to the mount's onExit → process.exit.
				void input.interactiveSession.stop();
				continue;
			}
			if (char === "\r" || char === "\n") {
				const completed = inputLineBuffer;
				inputLineBuffer = "";
				const session = input.interactiveSession;
				if (completed.length > 0) {
					// hax render_submitted parity: erase the plainly-echoed input
					// (prompt `❯ ` + text, soft-wrapped at the tty width) — the SAME
					// clear the submit path uses — so a consumed command's output
					// starts on a clean line. The cursor sits at the end of the typed
					// text, so return to col 0, climb to the prompt row, then clear to
					// end of screen.
					const cols = ttyCols(input.stdout);
					const len = Array.from(completed).length;
					const plainRows = Math.max(1, Math.ceil((STRIPE_COLS + len) / cols));
					let erase = "\r";
					if (plainRows > 1) erase += `\u001b[${plainRows - 1}A`;
					erase += "\u001b[J";
					input.stdout.write(erase);
					// Operator slash command: the adapter renders locally on the clean
					// line. No magenta stripe, no writeUserInput, no turn.
					if (await session.tryConsumeLocalCommand?.(completed)) {
						continue;
					}
					// Ordinary line: re-paint the bright-magenta `▌ ` stripe and submit.
					if (session.echoUserInput) {
						session.echoUserInput(completed, cols);
					} else {
						input.stdout.write("\n");
					}
					input.interactiveSession.writeUserInput(completed);
				} else {
					input.stdout.write("\n");
				}
				continue;
			}
			if (char === "\u0008" || char === "\u007f") {
				if (inputLineBuffer.length > 0) {
					inputLineBuffer = inputLineBuffer.slice(0, -1);
					input.stdout.write("\b \b");
				}
				continue;
			}
			inputLineBuffer += char;
			input.stdout.write(char);
		}
	}

	async function processChunk(raw: string) {
		if (overlayPush) {
			overlayPush(raw);
			return;
		}
		const normalized = normalizeTerminalInput({
			raw,
			state: inputState,
		});
		inputState = normalized.state;
		const sanitized = normalized.text;
		debug({
			type: "chunk",
			raw,
			rawHex: toHex(raw),
			sanitized,
			sanitizedHex: toHex(sanitized),
		});
		if (sanitized.length === 0) {
			return;
		}
		if (pausedInputDepth > 0) {
			return;
		}

		if (input.externalInputRouter) {
			const handled = await input.externalInputRouter.handleInput(sanitized);
			if (handled) {
				return;
			}
		}

		// Block input while the external turn gate is active (e.g. waiting for the
		// other agent to hand back the turn). Only Ctrl+C is allowed as a cancel signal.
		if (input.externalInputGate?.isBlocked()) {
			input.interactiveSession.sendLocalMessage(
				`\r\u001b[2K${input.externalInputGate.renderBlockedMessage()}`,
			);
			if (sanitized.includes("\x03")) {
				input.externalInputGate.onCancel();
			}
			return;
		}

		// Block input while relay work is in progress
		if (busyIndicator.isBusy()) {
			// Only allow Ctrl+C (0x03) to trigger cancellation
			if (sanitized.includes("\x03")) {
				if (input.onRelayCancel) {
					input.onRelayCancel();
				}
				busyIndicator.hide();
			}
			return;
		}

		for (const decision of lineBuffer.push(sanitized)) {
			debug({
				type: "decision",
				decision,
			});
			if (decision.kind === "buffering") {
				renderRelayPreview(decision.line);
				continue;
			}

			clearRelayPreview();
			if (decision.kind === "passthrough") {
				if (input.lineBufferedInput) {
					await feedLineBufferedInput(decision.data);
				} else {
					input.interactiveSession.writeUserInput(decision.data);
				}
				input.onActivity?.();
				continue;
			}
			if (decision.kind === "error") {
				input.interactiveSession.sendLocalMessage(
					`${decision.message}\n`,
				);
				continue;
			}
			if (decision.kind === "relay") {
				await handleLine(decision.line);
			}
		}
	}

	async function handleLine(line: string) {
		const directive = parseRelayDirective(line);
		debug({
			type: "handle-line",
			line,
			directive,
		});
		if (!directive) {
			return;
		}

		busyIndicator.show({
			senderAgent: directive.target === "pull" ? "pull" : directive.target,
			instruction: directive.instruction || "pull context",
		});

		try {
			const message = await input.onRelay(
				directive,
				(msg) => {
					if (input.relayPaneWriter) {
						input.relayPaneWriter.status({ content: msg, now: new Date().toISOString() });
					} else {
						input.interactiveSession.sendLocalMessage(msg);
					}
				},
			);
			if (message) {
				if (input.relayPaneWriter) {
					input.relayPaneWriter.status({ content: message, now: new Date().toISOString() });
				} else {
					input.interactiveSession.sendLocalMessage(message);
				}
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			input.interactiveSession.sendLocalMessage(
				`[ai-whisper] ${message}\n`,
			);
		} finally {
			busyIndicator.hide();
		}
	}

	return {
		async start() {
			await input.interactiveSession.start();

			setMountedRawMode(true);

			input.stdin.on("data", (chunk: Buffer | string) => {
				void processChunk(String(chunk));
			});
		},
		isPaused(): boolean {
			return pausedInputDepth > 0;
		},
		async withPausedInput<T>(run: () => Promise<T>): Promise<T> {
			pausedInputDepth += 1;
			if (pausedInputDepth === 1) {
				clearRelayPreview();
				setMountedRawMode(false);
			}
			try {
				return await run();
			} finally {
				pausedInputDepth = Math.max(0, pausedInputDepth - 1);
				if (pausedInputDepth === 0) {
					setMountedRawMode(true);
				}
			}
		},
		async runInteractiveOverlay(run: (io: OverlayIO) => Promise<void>): Promise<void> {
			// Suspend normal input processing but KEEP raw mode on (the picker needs
			// raw arrow keys). Route stdin chunks to the overlay's key stream.
			pausedInputDepth += 1;
			setMountedRawMode(true);
			const buf: string[] = [];
			const wakeHolder: { fn: (() => void) | null } = { fn: null };
			let done = false;
			overlayPush = (chunk) => {
				buf.push(chunk);
				wakeHolder.fn?.();
			};
			const keys = (async function* (): AsyncGenerator<string> {
				for (;;) {
					if (buf.length) {
						yield buf.shift()!;
						continue;
					}
					if (done) return;
					await new Promise<void>((r) => (wakeHolder.fn = r));
				}
			})();
			try {
				await run({
					keys,
					write: (s) => input.stdout.write(s),
					setRawMode: (on) => setMountedRawMode(on),
				});
			} finally {
				done = true;
				const fn = wakeHolder.fn;
				wakeHolder.fn = null;
				fn?.();
				overlayPush = null;
				pausedInputDepth = Math.max(0, pausedInputDepth - 1);
				setMountedRawMode(true); // mounted default is raw-on
			}
		},
		async stop() {
			clearRelayPreview();
			setMountedRawMode(Boolean(previousRawMode));
			await input.interactiveSession.stop();
		},
	};
}
