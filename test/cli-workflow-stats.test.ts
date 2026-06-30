import { describe, expect, it } from "vitest";
import { runWorkflowStats } from "../packages/cli/src/commands/workflow/stats.ts";
import type { HandsOffStats } from "../packages/broker/src/index.ts";

function fakeStdout() {
	let buf = "";
	const stream = {
		write: (s: string) => ((buf += s), true),
	} as unknown as NodeJS.WritableStream;
	return { stream, text: () => buf };
}

function stubBroker(stats: HandsOffStats) {
	return { control: { getHandsOffStats: () => stats } };
}

const POPULATED: HandsOffStats = {
	totalMs: 1_138_800_000, // 13d 4h
	count: 112,
	byStatus: {
		done: { count: 98, totalMs: 972_000_000 }, // 11d 6h
		halted: { count: 14, totalMs: 166_800_000 }, // 1d 22h
	},
	earliestKickoffAt: "2026-05-21T03:17:25.898Z",
	skipped: 0,
};

const EMPTY: HandsOffStats = {
	totalMs: 0,
	count: 0,
	byStatus: {
		done: { count: 0, totalMs: 0 },
		halted: { count: 0, totalMs: 0 },
	},
	earliestKickoffAt: null,
	skipped: 0,
};

describe("runWorkflowStats", () => {
	it("prints the human summary with since date and per-bucket lines", () => {
		const out = fakeStdout();
		runWorkflowStats({ broker: stubBroker(POPULATED), stdout: out.stream });
		const text = out.text();
		expect(text).toContain(
			"Hands-off time saved: 13d 4h  (112 workflows, since 2026-05-21)",
		);
		expect(text).toContain("  done     98 runs · 11d 6h");
		expect(text).toContain("  halted   14 runs · 1d 22h");
	});

	it("prints the empty-DB message when there are no counted runs", () => {
		const out = fakeStdout();
		runWorkflowStats({ broker: stubBroker(EMPTY), stdout: out.stream });
		expect(out.text().trim()).toBe(
			"Hands-off time saved: 0m (no completed workflows yet)",
		);
	});

	it("emits the JSON shape with totalHuman, per-bucket human, and full-ISO since", () => {
		const out = fakeStdout();
		runWorkflowStats({
			broker: stubBroker(POPULATED),
			json: true,
			stdout: out.stream,
		});
		const parsed = JSON.parse(out.text());
		expect(parsed).toEqual({
			totalMs: 1_138_800_000,
			totalHuman: "13d 4h",
			count: 112,
			since: "2026-05-21T03:17:25.898Z",
			byStatus: {
				done: { count: 98, totalMs: 972_000_000, human: "11d 6h" },
				halted: { count: 14, totalMs: 166_800_000, human: "1d 22h" },
			},
			skipped: 0,
		});
	});

	it("emits zeroed JSON with since:null for the empty case", () => {
		const out = fakeStdout();
		runWorkflowStats({
			broker: stubBroker(EMPTY),
			json: true,
			stdout: out.stream,
		});
		const parsed = JSON.parse(out.text()) as Record<string, unknown>;
		expect(parsed.totalMs).toBe(0);
		expect(parsed.count).toBe(0);
		expect(parsed.since).toBeNull();
		expect(parsed.byStatus).toEqual({
			done: { count: 0, totalMs: 0, human: "0m" },
			halted: { count: 0, totalMs: 0, human: "0m" },
		});
	});
});
