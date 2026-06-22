import { describe, it, expect } from "vitest";
import {
	deliberationRunDir,
	deriveFindingsPath,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("deliberationRunDir", () => {
	it("builds a gitignored run dir under .ai-whisper/deliberation", () => {
		expect(deliberationRunDir("/ws", "wf_abc")).toBe(
			"/ws/.ai-whisper/deliberation/wf_abc",
		);
	});
});

describe("deriveFindingsPath", () => {
	it("date-stamps + slugifies the seed basename under docs/superpowers/deliberations", () => {
		expect(deriveFindingsPath("docs/ideas/14all-samantha.md", "2026-06-21T09:00:00Z")).toBe(
			"docs/superpowers/deliberations/2026-06-21-14all-samantha.md",
		);
	});
	it("strips a leading date prefix from the seed name", () => {
		expect(deriveFindingsPath("2026-01-02-my-topic.txt", "2026-06-21")).toBe(
			"docs/superpowers/deliberations/2026-06-21-my-topic.md",
		);
	});
	it("falls back to 'deliberation' when the seed name has no usable slug", () => {
		expect(deriveFindingsPath("/tmp/.md", "2026-06-21")).toBe(
			"docs/superpowers/deliberations/2026-06-21-deliberation.md",
		);
	});
	it("throws on a malformed dateIso", () => {
		expect(() => deriveFindingsPath("seed.md", "nope")).toThrow(/YYYY-MM-DD/);
	});
});
