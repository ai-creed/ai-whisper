import { describe, expect, it } from "vitest";
import { QuotaExhaustedError, UsageLimitWatcher, detectUsageLimit } from "../eval/runner/quota.ts";

describe("detectUsageLimit", () => {
	it("recognises the codex ChatGPT limit, through terminal escape codes, and keeps the reset hint", () => {
		const raw = "\x1b[31m■ You\u2019ve hit your usage limit.\x1b[0m Upgrade to Pro, or\x1b[34;1Htry again at 4:00 PM.";
		const hit = detectUsageLimit(raw);
		expect(hit).not.toBeNull();
		expect(hit).toMatch(/try again at 4:00 PM/);
	});
	it("recognises the claude limit messages, old and new", () => {
		expect(detectUsageLimit("Claude AI usage limit reached|1760000000")).not.toBeNull();
		expect(detectUsageLimit("You've hit your limit · resets 4pm (Asia/Saigon)")).toMatch(/resets 4pm/);
		expect(detectUsageLimit("Claude usage limit reached. Your limit will reset at 3pm.")).not.toBeNull();
	});
	it("recognises every limit message the pinned claude CLI (2.1.293) builds", () => {
		for (const s of [
			"You've hit your session limit · resets 3pm (Asia/Saigon)",
			"You've hit your weekly limit · resets Mon 9am",
			"You've hit your Opus limit",
			"You've hit your Sonnet limit",
			"You've hit your usage credit limit",
			"You've reached your Fable limit",
			"5-hour limit reached ∙ resets 3pm",
		]) expect(detectUsageLimit(s), s).not.toBeNull();
	});
	it("does not fire on code or prose an agent writes about limits", () => {
		for (const s of [
			'throw new Error("usage limit reached")',
			"the limit will reset at the window boundary",
			"You have reached your usage limit for this key",
			"return { error: \"You've hit your rate limit\" };",
			"// once you hit your limit the bucket refills",
			"the sliding window rejects once the rate limit is reached",
			"it('rejects after the per-key usage limit', () => {})",
			"throw new Error(`limit reached for ${key}`)",
			"maxUsage limit: 100",
		]) expect(detectUsageLimit(s), s).toBeNull();
	});
});

describe("UsageLimitWatcher", () => {
	it("picks up a reset hint that arrives in a later chunk, and trims the terminal clutter after the message", () => {
		const w = new UsageLimitWatcher();
		w.feed("\x1b[31m■ You've hit your usage limit.\x1b[0m Upgrade to Pro, or");
		expect(w.hit).not.toBeNull();
		w.feed("\x1b[34;1Htry again at 4:00 PM. ⠋ [ai-whisper] auto-handback fired for chain ch_1");
		expect(w.hit).toMatch(/4:00 PM/);
		expect(w.hit).not.toMatch(/ai-whisper|⠋/);
	});
	it("detects a message split across output chunks and keeps the first hit", () => {
		const w = new UsageLimitWatcher();
		w.feed("working... You've hit your us");
		expect(w.hit).toBeNull();
		w.feed("age limit. try again at 4:00 PM");
		expect(w.hit).toMatch(/usage limit/);
		w.feed("\nClaude AI usage limit reached");
		expect(w.hit).toMatch(/^You've hit your usage limit/); // the first message keeps the lead
	});
});

describe("QuotaExhaustedError", () => {
	it("names the agent and the detail", () => {
		const e = new QuotaExhaustedError("codex", "You've hit your usage limit. try again at 4:00 PM");
		expect(e.name).toBe("QuotaExhaustedError");
		expect(e.agent).toBe("codex");
		expect(e.message).toMatch(/codex.*usage limit/);
	});
});
