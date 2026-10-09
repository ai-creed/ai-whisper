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
	it("does not fire on code or prose an agent writes about limits", () => {
		for (const s of [
			"the sliding window rejects once the rate limit is reached",
			"it('rejects after the per-key usage limit', () => {})",
			"throw new Error(`limit reached for ${key}`)",
			"maxUsage limit: 100",
		]) expect(detectUsageLimit(s), s).toBeNull();
	});
});

describe("UsageLimitWatcher", () => {
	it("detects a message split across output chunks and keeps the first hit", () => {
		const w = new UsageLimitWatcher();
		w.feed("working... You've hit your us");
		expect(w.hit).toBeNull();
		w.feed("age limit. try again at 4:00 PM");
		expect(w.hit).toMatch(/usage limit/);
		const first = w.hit;
		w.feed("Claude AI usage limit reached");
		expect(w.hit).toBe(first);
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
