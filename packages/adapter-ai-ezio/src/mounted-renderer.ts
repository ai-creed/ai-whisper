/**
 * Mounted ezio pane renderer (M8). Owns ALL presentation for a mounted ezio
 * session — banner, thinking spinner, markdown (at turn end), tool calls
 * (invocation + output preview + colored diffs), usage line, prompt, errors —
 * driven entirely by protocol events (engine stays protocol-native; no PTY, no
 * scraping). Pure unit: feed it events via `handle()`, it writes ANSI to stdout.
 * Timer + UTF-8 detection are injectable seams so spinner idle-safety and the
 * prompt fallback are deterministically testable.
 */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { renderMarkdown } from "./render-markdown.js";

const ESC = "";
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const CYAN = `${ESC}[36m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const MAGENTA = `${ESC}[35m`;
const CLEAR_LINE = `\r${ESC}[2K`;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PREVIEW_LINES = 4;
const ARG_MAX = 80;

// Mirrors hax's format_tokens (vendor/hax/src/agent.c) — binary k/M with the
// same rounding: 595 -> "595", 8900 -> "8.7k", 262144 -> "256k".
function fmtTokens(n: number): string {
	if (n < 0) return "?";
	if (n < 1024) return String(n);
	if (n < 10 * 1024) return `${(n / 1024).toFixed(1)}k`;
	if (n < 1024 * 1024) return `${Math.floor((n + 512) / 1024)}k`;
	if (n < 10 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
	return `${Math.floor((n + 512 * 1024) / (1024 * 1024))}M`;
}

function truncate(s: string, max = ARG_MAX): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

type UsageT = NonNullable<Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"]>;

export function createMountedRenderer(input: {
	stdout: NodeJS.WritableStream;
	utf8?: boolean;
	setInterval?: (cb: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}) {
	const utf8 = input.utf8 ?? true;
	const setI = input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
	const clrI = input.clearInterval ?? ((h) => globalThis.clearInterval(h as never));
	const w = (s: string) => input.stdout.write(s);
	const prompt = utf8 ? `${MAGENTA}${BOLD}❯${RESET} ` : "> ";

	let bannerRendered = false;
	let lastUsage: UsageT | undefined;
	// spinner
	let spinHandle: unknown = null;
	let spinFrame = 0;
	let spinVisible = false;
	let spinRunning = false;

	const stopSpinner = () => {
		if (spinHandle !== null) {
			clrI(spinHandle);
			spinHandle = null;
		}
		spinRunning = false;
		if (spinVisible) {
			w(CLEAR_LINE);
			spinVisible = false;
		}
	};
	const tick = () => {
		if (!spinRunning) return; // idle-safety: a stale interval writes nothing
		w(`${CLEAR_LINE}${DIM}${SPIN[spinFrame++ % SPIN.length]} thinking…${RESET}`);
		spinVisible = true;
	};
	const startSpinner = () => {
		spinFrame = 0;
		spinRunning = true;
		tick();
		spinHandle = setI(tick, 80);
	};

	const renderBanner = (provider: string, model: string, effort: string) => {
		// Banner uses hax's dim `›` (matches `hax › codex · …`); the magenta `❯`
		// is reserved for the input prompt below.
		const tail = effort ? `${provider} · ${model} · ${effort}` : `${provider} · ${model}`;
		w(`${CYAN}▌${RESET} ${BOLD}ezio${RESET} ${DIM}› ${tail}${RESET}\n`);
	};

	const usageLine = (u: UsageT): string => {
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
		return parts.length > 0 ? `${DIM}${parts.join(" · ")}${RESET}` : "";
	};

	const renderToolStart = (name: string, args?: string) => {
		const tail = args ? ` · ${truncate(args)}` : "";
		w(`\n${DIM}⏺ ${name}${tail}${RESET}`);
	};

	const renderToolFinish = (status: "ok" | "error", output?: string, isDiff?: boolean) => {
		if (isDiff && output) {
			for (const line of output.split("\n")) {
				if (line.length === 0) continue;
				const color = line.startsWith("+") ? GREEN : line.startsWith("-") ? RED : DIM;
				w(`\n${color}${line}${RESET}`);
			}
			return;
		}
		const color = status === "error" ? RED : DIM;
		const lines = (output ?? "").split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) {
			if (status === "error") w(`\n${RED}  (error)${RESET}`);
			return;
		}
		for (const l of lines.slice(0, PREVIEW_LINES)) w(`\n${color}  ${truncate(l, 120)}${RESET}`);
		if (lines.length > PREVIEW_LINES) w(`\n${DIM}  …(+${lines.length - PREVIEW_LINES})${RESET}`);
	};

	return {
		handle(event: ProtocolEvent): void {
			switch (event.type) {
				case "status":
					if (!bannerRendered) {
						renderBanner(event.provider, event.model, event.effort ?? "");
						bannerRendered = true;
					}
					break;
				case "user_turn_started":
					startSpinner();
					break;
				case "assistant_delta":
					// Suppressed from the pane — markdown renders at turn end. (The
					// live-session still forwards deltas to onProviderOutput.)
					break;
				case "tool_call_started":
					stopSpinner();
					renderToolStart(event.name, event.args);
					break;
				case "tool_call_finished":
					renderToolFinish(event.status, event.output, event.isDiff);
					break;
				case "assistant_turn_finished":
					stopSpinner();
					lastUsage = event.usage;
					if (event.content) w(`\n${renderMarkdown(event.content)}\n`);
					break;
				case "idle":
					stopSpinner();
					if (lastUsage) {
						const u = usageLine(lastUsage);
						if (u) w(`\n${u}`);
						lastUsage = undefined;
					}
					w(`\n${prompt}`);
					break;
				case "error":
					stopSpinner();
					w(`\n${RED}▌ ${event.message}${RESET}\n${prompt}`);
					break;
				default:
					break;
			}
		},
	};
}
