import { describe, expect, it, vi } from "vitest";
import {
	appendCursorCaptureLog,
	cursorCaptureLogPath,
} from "../packages/cli/src/runtime/cursor-capture-log.ts";

describe("cursorCaptureLogPath", () => {
	it("resolves to <home>/.ai-whisper/logs/cursor-capture.jsonl", () => {
		expect(cursorCaptureLogPath("/home/me")).toBe(
			"/home/me/.ai-whisper/logs/cursor-capture.jsonl",
		);
	});
});

describe("appendCursorCaptureLog", () => {
	it("appends one JSON line carrying a timestamp and the record fields", () => {
		const appended: Array<{ path: string; data: string }> = [];
		appendCursorCaptureLog(
			{ collabId: "collab_1", status: "captured", chosenPath: "/t.jsonl", textLen: 42 },
			{
				home: "/home/me",
				now: () => "2026-07-01T00:00:00.000Z",
				mkdir: () => {},
				append: (path, data) => appended.push({ path, data }),
			},
		);
		expect(appended).toHaveLength(1);
		expect(appended[0]!.path).toBe("/home/me/.ai-whisper/logs/cursor-capture.jsonl");
		expect(appended[0]!.data.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(appended[0]!.data.trim());
		expect(parsed).toMatchObject({
			ts: "2026-07-01T00:00:00.000Z",
			collabId: "collab_1",
			status: "captured",
			chosenPath: "/t.jsonl",
			textLen: 42,
		});
	});

	it("ensures the logs directory exists before appending", () => {
		const mkdir = vi.fn();
		appendCursorCaptureLog(
			{ status: "captured" },
			{ home: "/home/me", mkdir, append: () => {} },
		);
		expect(mkdir).toHaveBeenCalledWith("/home/me/.ai-whisper/logs");
	});

	it("never throws when the underlying write fails (best-effort)", () => {
		expect(() =>
			appendCursorCaptureLog(
				{ status: "captured" },
				{
					home: "/home/me",
					mkdir: () => {},
					append: () => {
						throw new Error("disk full");
					},
				},
			),
		).not.toThrow();
	});
});
