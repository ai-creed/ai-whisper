import { THEME } from "./theme.js";

export type StatusKey = "running" | "stuck" | "done" | "canceled" | "idle";

export type GlyphResult = {
	glyph: "●" | "⚠" | "✓" | "✖" | "◌";
	color: (typeof THEME)[keyof typeof THEME];
	key: StatusKey;
};

export function statusGlyph(input: {
	workflowStatus: "running" | "paused" | "done" | "halted" | "canceled" | null;
	stuck: boolean;
}): GlyphResult {
	// No bound workflow → idle/manual relay.
	if (input.workflowStatus === null) {
		return { glyph: "◌", color: THEME.muted, key: "idle" };
	}
	// Terminal/lifecycle ends have their own glyphs, distinct from stuck.
	if (input.workflowStatus === "done") {
		return { glyph: "✓", color: THEME.ok, key: "done" };
	}
	if (input.workflowStatus === "canceled") {
		return { glyph: "✖", color: THEME.err, key: "canceled" };
	}
	// Halted always uses the stuck glyph (operator/system stopped a run).
	if (input.workflowStatus === "halted") {
		return { glyph: "⚠", color: THEME.err, key: "stuck" };
	}
	// workflowStatus === "running": glyph keys off the runtime stuck flag.
	return input.stuck
		? { glyph: "⚠", color: THEME.err, key: "stuck" }
		: { glyph: "●", color: THEME.accent, key: "running" };
}
