import { describe, expect, it } from "vitest";
import { statusGlyph } from "../packages/cli/src/runtime/dashboard-glyph.ts";
import { THEME } from "../packages/cli/src/runtime/theme.ts";

describe("statusGlyph", () => {
	it("running (not stuck) → ● accent", () => {
		expect(statusGlyph({ workflowStatus: "running", stuck: false })).toEqual({
			glyph: "●",
			color: THEME.accent,
			key: "running",
		});
	});
	it("running + stuck → ⚠ err", () => {
		expect(statusGlyph({ workflowStatus: "running", stuck: true })).toEqual({
			glyph: "⚠",
			color: THEME.err,
			key: "stuck",
		});
	});
	it("halted → ⚠ err (regardless of stuck flag)", () => {
		expect(statusGlyph({ workflowStatus: "halted", stuck: false })).toEqual({
			glyph: "⚠",
			color: THEME.err,
			key: "stuck",
		});
		expect(statusGlyph({ workflowStatus: "halted", stuck: true })).toEqual({
			glyph: "⚠",
			color: THEME.err,
			key: "stuck",
		});
	});
	it("done → ✓ ok", () => {
		expect(statusGlyph({ workflowStatus: "done", stuck: false })).toEqual({
			glyph: "✓",
			color: THEME.ok,
			key: "done",
		});
	});
	it("canceled → ✖ err (NOT the stuck glyph)", () => {
		expect(statusGlyph({ workflowStatus: "canceled", stuck: false })).toEqual({
			glyph: "✖",
			color: THEME.err,
			key: "canceled",
		});
	});
	it("null workflow (manual relay) → ◌ muted", () => {
		expect(statusGlyph({ workflowStatus: null, stuck: false })).toEqual({
			glyph: "◌",
			color: THEME.muted,
			key: "idle",
		});
	});
	it("paused → ‖ muted (distinct from running and halted)", () => {
		expect(statusGlyph({ workflowStatus: "paused", stuck: false })).toEqual({
			glyph: "‖",
			color: THEME.muted,
			key: "paused",
		});
		// stuck flag is irrelevant for a paused run
		expect(statusGlyph({ workflowStatus: "paused", stuck: true }).key).toBe("paused");
	});
});
