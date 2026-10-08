import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZERO_USAGE, addUsage, type UsageTotals } from "../types.ts";

type ClaudeLine = { type?: string; cwd?: string; message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } };
type CodexLine = { type?: string; payload?: { type?: string; cwd?: string; info?: { total_token_usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } } } };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function parseJson<T>(line: string): T | null {
	const t = line.trim();
	if (!t.startsWith("{")) return null;
	try { return JSON.parse(t) as T; } catch { return null; }
}

export function parseClaudeTranscriptLines(lines: Iterable<string>, cwds: readonly string[]): UsageTotals | null {
	const match = new Set(cwds);
	const byId = new Map<string, UsageTotals>();
	let anon: UsageTotals | null = null;
	for (const line of lines) {
		const ev = parseJson<ClaudeLine>(line);
		if (!ev || ev.type !== "assistant" || ev.cwd === undefined || !match.has(ev.cwd) || !ev.message?.usage) continue;
		const u = ev.message.usage;
		const usage: UsageTotals = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens), cacheReadTokens: num(u.cache_read_input_tokens) };
		if (typeof ev.message.id === "string") byId.set(ev.message.id, usage);
		else anon = addUsage(anon ?? ZERO_USAGE, usage);
	}
	if (byId.size === 0 && anon === null) return null;
	let total = anon ?? ZERO_USAGE;
	for (const u of byId.values()) total = addUsage(total, u);
	return total;
}

export function parseCodexRolloutLines(lines: Iterable<string>, cwds: readonly string[]): UsageTotals | null {
	const match = new Set(cwds);
	let matchesCwd = false;
	let last: UsageTotals | null = null;
	for (const line of lines) {
		const ev = parseJson<CodexLine>(line);
		if (!ev) continue;
		if (ev.type === "session_meta" && ev.payload?.cwd !== undefined && match.has(ev.payload.cwd)) matchesCwd = true;
		const t = ev.payload?.info?.total_token_usage;
		if (ev.type === "event_msg" && ev.payload?.type === "token_count" && t) {
			const cached = num(t.cached_input_tokens);
			// Codex input_tokens already includes cached_input_tokens; subtract so pricing does not bill cached input twice.
			last = { inputTokens: Math.max(0, num(t.input_tokens) - cached), outputTokens: num(t.output_tokens), cacheWriteTokens: 0, cacheReadTokens: cached };
		}
	}
	return matchesCwd ? last : null;
}

function walkJsonl(dir: string, out: string[]): void {
	if (!existsSync(dir)) return;
	let entries: Dirent[];
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walkJsonl(p, out);
		else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
	}
}

function harvest(root: string, window: { since: number; until: number }, parse: (lines: string[]) => UsageTotals | null): UsageTotals | null {
	const files: string[] = [];
	walkJsonl(root, files);
	let total: UsageTotals | null = null;
	for (const f of files) {
		let mtime: number;
		try { mtime = statSync(f).mtimeMs; } catch { continue; }
		if (mtime < window.since || mtime > window.until + 60_000) continue;
		let text: string;
		try { text = readFileSync(f, "utf8"); } catch { continue; }
		const u = parse(text.split("\n"));
		if (u) total = addUsage(total ?? ZERO_USAGE, u);
	}
	return total;
}

/** `cwds`: every spelling of the workspace a session may have recorded (e.g. the path as given and its realpath). */
export function harvestClaudeUsage(input: { home?: string; cwds: readonly string[]; since: number; until: number }): UsageTotals | null {
	return harvest(join(input.home ?? homedir(), ".claude", "projects"), input, (lines) => parseClaudeTranscriptLines(lines, input.cwds));
}

export function harvestCodexUsage(input: { home?: string; cwds: readonly string[]; since: number; until: number }): UsageTotals | null {
	return harvest(join(input.home ?? homedir(), ".codex", "sessions"), input, (lines) => parseCodexRolloutLines(lines, input.cwds));
}
