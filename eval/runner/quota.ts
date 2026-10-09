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
// Narrow on purpose: agents write about rate limits in task code, so only the CLIs' own account-limit phrasing counts.
const LIMIT = /hit your (?:usage )?limit|usage limit reached|reached your usage limit|limit will reset at/i;
const RESET_HINT = /(?:try again at|resets?(?: at)?)\s+[^.\n·]{1,40}/i;

function clean(text: string): string {
	return text.replace(SGR, "").replace(OTHER_ESCAPES, " ").replace(/[ \t]+/g, " ");
}

/** The limit message with its reset hint, or null. */
export function detectUsageLimit(text: string): string | null {
	const t = clean(text);
	const m = LIMIT.exec(t);
	if (!m) return null;
	const around = t.slice(Math.max(0, m.index - 20), m.index + 240);
	const hint = RESET_HINT.exec(t.slice(m.index));
	const head = around.split("\n").find((l) => LIMIT.test(l))?.trim() ?? m[0];
	return hint && !head.includes(hint[0].trim()) ? `${head} (${hint[0].trim()})` : head;
}

/** Streams terminal output; remembers the first limit message seen, including one split across chunks. */
export class UsageLimitWatcher {
	hit: string | null = null;
	private tail = "";
	feed(chunk: string): void {
		if (this.hit !== null) return;
		this.tail = (this.tail + chunk).slice(-4000);
		this.hit = detectUsageLimit(this.tail);
	}
}
