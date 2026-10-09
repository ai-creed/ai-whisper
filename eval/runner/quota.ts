/**
 * Seat usage limits (claude.ai 5-hour window, ChatGPT plan quota) are an operator-account condition, not a
 * property of the system under test. A run that hits one is aborted and returned to pending rather than scored,
 * and the slice stops so later runs are not burned the same way.
 */

export class QuotaExhaustedError extends Error {
	constructor(public readonly agent: string, public readonly detail: string) {
		super(`${agent} hit its usage limit: ${detail}`);
		this.name = "QuotaExhaustedError";
	}
}

// Colour codes vanish; cursor moves become a space so words on either side stay apart.
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const SGR = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const OTHER_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g;
// Anchored to the CLIs' own wording (claude 2.1.x builds `You've hit your ${kind} limit` / `You've reached your ${model}
// limit`; codex prints `You've hit your usage limit`). Agents write about rate limits in task code, so bare phrases
// such as "usage limit reached" or "limit will reset at" do not count, and the qualifier list excludes "rate".
const LIMIT = /you['’]ve (?:hit|reached) your (?:session |weekly |daily |monthly |opus |sonnet |fable |haiku |usage credit |usage )?limit\b|claude(?: ai)? usage limit reached|\b\d+-hour limit reached/i;
const RESET_HINT = /(?:try again at|resets?(?: at)?)\s+[^.\n·∙⠀-⣿[]{1,40}/i;
// Where the CLI's message ends and unrelated terminal output (spinner frames, ai-whisper status lines) begins.
const CLUTTER = /\[ai-whisper\]|[⠀-⣿]/;

function clean(text: string): string {
	return text.replace(SGR, "").replace(OTHER_ESCAPES, " ").replace(/[ \t]+/g, " ");
}

/** The limit message with its reset hint, or null. */
export function detectUsageLimit(text: string): string | null {
	const t = clean(text);
	const m = LIMIT.exec(t);
	if (!m) return null;
	let rest = t.slice(m.index, m.index + 300);
	const cut = CLUTTER.exec(rest);
	if (cut) rest = rest.slice(0, cut.index);
	const head = (rest.split("\n")[0] ?? m[0]).trim();
	const hint = RESET_HINT.exec(rest);
	const detail = hint && !head.includes(hint[0].trim()) ? `${head} (${hint[0].trim()})` : head;
	return detail.slice(0, 200);
}

/** Streams terminal output; remembers the first limit message seen, including one split across chunks. */
export class UsageLimitWatcher {
	private tail = "";
	private matched = false;
	private after = 0;
	/** Keeps reading a little past the first match, so a reset hint printed a moment later is part of the detail. */
	feed(chunk: string): void {
		if (this.matched) {
			if (this.after >= 400) return;
			this.after += chunk.length;
			this.tail += chunk;
			return;
		}
		this.tail = (this.tail + chunk).slice(-4000);
		if (detectUsageLimit(this.tail) !== null) this.matched = true;
	}
	get hit(): string | null {
		return this.matched ? detectUsageLimit(this.tail) : null;
	}
}
