// test/eval-manifest.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, claimRun, completeRun, loadManifest, runKey, saveManifest, scheduledPerArm, selectSlice, summarize } from "../eval/runner/manifest.ts";
import type { Pins } from "../eval/runner/types.ts";

const pins: Pins = {
	implementerModel: "claude-sonnet-4-5", reviewerModel: "gpt-5", billing: "api",
	evaluator: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null },
	cliVersions: { whisper: "0.16.0+abc", claude: "2.0.0", codex: "0.50.0" },
};
const now = "2026-08-19T00:00:00.000Z";
const build = () => buildManifest({ campaignId: "c1", taskSlugs: ["t1", "t2", "t3"], trials: 2, seed: 42, pins, sourceStateRoot: "/x", now });

describe("buildManifest", () => {
	it("schedules every task×arm×trial exactly once, shuffled by seed", () => {
		const m = build();
		expect(m.runs).toHaveLength(18);
		expect(new Set(m.runs.map(runKey)).size).toBe(18);
		expect(m.runs.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
		expect(build().runs.map(runKey)).toEqual(m.runs.map(runKey));
		expect(buildManifest({ campaignId: "c1", taskSlugs: ["t1", "t2", "t3"], trials: 2, seed: 7, pins, sourceStateRoot: "/x", now }).runs.map(runKey)).not.toEqual(m.runs.map(runKey));
	});
});

describe("claim / complete / slice", () => {
	it("claims pending → running with attempts+1 and completes to done", () => {
		const m = build();
		const key = runKey(m.runs[0]!);
		const claimed = claimRun(m, key, now, "/runs/x");
		expect(claimed.runs[0]).toMatchObject({ status: "running", attempts: 1, runDir: "/runs/x", startedAt: now });
		const done = completeRun(claimed, key, "done", now);
		expect(done.runs[0]).toMatchObject({ status: "done", endedAt: now });
		expect(() => claimRun(done, key, now, "/runs/y")).toThrow(/already done/);
	});
	it("running rows are reclaimable (crash recovery) and count another attempt", () => {
		const m = build();
		const key = runKey(m.runs[0]!);
		const once = claimRun(m, key, now, "/runs/x");
		const twice = claimRun(once, key, now, "/runs/x");
		expect(twice.runs[0]).toMatchObject({ status: "running", attempts: 2 });
		expect(selectSlice(once, {}).map(runKey)).toContain(key);
	});
	it("selectSlice filters by arm/task/limit and excludes failed unless asked", () => {
		let m = build();
		const first = runKey(m.runs[0]!);
		m = completeRun(claimRun(m, first, now, "/r"), first, "failed", now);
		expect(selectSlice(m, {}).map(runKey)).not.toContain(first);
		expect(selectSlice(m, { includeFailed: true }).map(runKey)).toContain(first);
		expect(selectSlice(m, { arms: ["C"] }).every((r) => r.arm === "C")).toBe(true);
		expect(selectSlice(m, { tasks: ["t2"] }).every((r) => r.task === "t2")).toBe(true);
		expect(selectSlice(m, { limit: 4 })).toHaveLength(4);
	});
	it("scheduledPerArm is tasks × trials", () => {
		expect(scheduledPerArm(build())).toBe(6);
	});
	it("summarize counts per status and per arm", () => {
		let m = build();
		const k = runKey(m.runs[0]!);
		m = completeRun(claimRun(m, k, now, "/r"), k, "done", now);
		const s = summarize(m);
		expect(s.done).toBe(1);
		expect(s.pending).toBe(17);
		expect(s.byArm.A.total + s.byArm.B.total + s.byArm.C.total).toBe(18);
	});
});

describe("load / save", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("round-trips through disk and validates on load", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-manifest-"));
		const m = build();
		saveManifest(dir, m);
		expect(loadManifest(dir)).toEqual(m);
	});
});
