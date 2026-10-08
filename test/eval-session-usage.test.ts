import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harvestClaudeUsage, harvestCodexUsage, parseClaudeTranscriptLines, parseCodexRolloutLines } from "../eval/runner/arms/session-usage.ts";

const claudeLine = (id: string, cwd: string, inp: number, out: number) => JSON.stringify({ type: "assistant", cwd, message: { id, usage: { input_tokens: inp, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 3 } } });
const codexMeta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { id: "s", cwd } });
const codexCount = (inp: number, cached: number, out: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out } } } });

describe("parseClaudeTranscriptLines", () => {
	it("sums assistant usage for the matching cwd, deduped by message id", () => {
		const u = parseClaudeTranscriptLines([claudeLine("a", "/ws", 10, 1), claudeLine("a", "/ws", 10, 4), claudeLine("b", "/ws", 5, 1), claudeLine("c", "/other", 99, 99), "junk"], ["/ws"]);
		expect(u).toEqual({ inputTokens: 15, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 6 });
	});
	it("matches any of the given cwds (the path as given and its physical form)", () => {
		expect(parseClaudeTranscriptLines([claudeLine("a", "/alias/ws", 1, 1), claudeLine("b", "/real/ws", 2, 2)], ["/alias/ws", "/real/ws"])).toEqual({ inputTokens: 3, outputTokens: 3, cacheWriteTokens: 0, cacheReadTokens: 6 });
	});
	it("returns null when nothing matches", () => {
		expect(parseClaudeTranscriptLines([claudeLine("a", "/other", 1, 1)], ["/ws"])).toBeNull();
	});
});

describe("parseCodexRolloutLines", () => {
	it("takes the last token_count total for a session in the cwd", () => {
		expect(parseCodexRolloutLines([codexMeta("/ws"), codexCount(10, 2, 1), codexCount(30, 5, 4)], ["/ws"])).toEqual({ inputTokens: 25, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 5 });
	});
	it("matches a session whose cwd is any of the given cwds", () => {
		expect(parseCodexRolloutLines([codexMeta("/real/ws"), codexCount(10, 0, 1)], ["/alias/ws", "/real/ws"])).toEqual({ inputTokens: 10, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 });
	});
	it("returns null for another cwd or no token_count", () => {
		expect(parseCodexRolloutLines([codexMeta("/other"), codexCount(1, 0, 1)], ["/ws"])).toBeNull();
		expect(parseCodexRolloutLines([codexMeta("/ws")], ["/ws"])).toBeNull();
	});
});

describe("harvesters", () => {
	let home: string;
	afterEach(() => rmSync(home, { recursive: true, force: true }));
	it("sum files whose mtime is inside the run window and ignore the rest", () => {
		home = mkdtempSync(join(tmpdir(), "eval-home-"));
		const cdir = join(home, ".claude", "projects", "-ws"); mkdirSync(cdir, { recursive: true });
		writeFileSync(join(cdir, "in.jsonl"), claudeLine("a", "/ws", 7, 1) + "\n");
		writeFileSync(join(cdir, "old.jsonl"), claudeLine("z", "/ws", 1000, 1000) + "\n");
		utimesSync(join(cdir, "old.jsonl"), new Date(0), new Date(0));
		const xdir = join(home, ".codex", "sessions", "2026", "08", "19"); mkdirSync(xdir, { recursive: true });
		writeFileSync(join(xdir, "rollout-1.jsonl"), [codexMeta("/ws"), codexCount(20, 0, 2)].join("\n") + "\n");
		const now = Date.now();
		expect(harvestClaudeUsage({ home, cwds: ["/ws"], since: now - 60_000, until: now })).toEqual({ inputTokens: 7, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 3 });
		expect(harvestCodexUsage({ home, cwds: ["/ws"], since: now - 60_000, until: now })).toEqual({ inputTokens: 20, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0 });
	});
	it("return null (never throw) with zero matching files or a missing home", () => {
		home = mkdtempSync(join(tmpdir(), "eval-home-"));
		expect(harvestClaudeUsage({ home, cwds: ["/ws"], since: 0, until: Date.now() })).toBeNull();
		expect(harvestCodexUsage({ home: join(home, "missing"), cwds: ["/ws"], since: 0, until: Date.now() })).toBeNull();
	});
});
