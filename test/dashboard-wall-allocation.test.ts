import { describe, expect, it } from "vitest";
import {
	allocateWallSections,
	partitionWallGroups,
} from "../packages/cli/src/runtime/dashboard-state.ts";
import type { CollabSummary } from "@ai-whisper/broker";

function s(p: Partial<CollabSummary>): CollabSummary {
	return {
		collabId: p.collabId ?? "c",
		label: "x",
		workflowId: p.workflowId ?? "wf",
		workflowType: "spec-driven-development",
		workflowStatus: p.workflowStatus ?? "running",
		currentPhaseRunId: null,
		phaseIndex: 0,
		phaseName: "p",
		currentRound: 1,
		maxRounds: 3,
		chainStatus: p.chainStatus ?? "active",
		turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
		sessions: [
			{ agentType: "codex", healthState: "healthy", mountAlive: true },
			{ agentType: "claude", healthState: "healthy", mountAlive: true },
		],
		workflowCreatedAt: p.workflowCreatedAt ?? "2026-05-20T00:00:00.000Z",
		specPath: null,
		lastActivityAt: p.lastActivityAt ?? "2026-05-20T00:00:00.000Z",
		...p,
	};
}

describe("partitionWallGroups", () => {
	it("partitions into ACTIVE / IDLE-MANUAL / HALTED / DONE-CANCELED in that order", () => {
		const out = partitionWallGroups([
			s({ collabId: "d", workflowStatus: "done" }),
			s({ collabId: "h", workflowStatus: "halted" }),
			s({ collabId: "m", workflowId: null, workflowStatus: null, workflowType: null }),
			s({ collabId: "r", workflowStatus: "running" }),
			s({ collabId: "x", workflowStatus: "canceled" }),
		]);
		expect(out.active.map((x) => x.collabId)).toEqual(["r"]);
		expect(out.idleManual.map((x) => x.collabId)).toEqual(["m"]);
		expect(out.halted.map((x) => x.collabId)).toEqual(["h"]);
		expect(out.doneCanceled.map((x) => x.collabId)).toEqual(["d", "x"]);
	});

	it("sorts each group by workflowCreatedAt descending", () => {
		const out = partitionWallGroups([
			s({ collabId: "old", workflowStatus: "running", workflowCreatedAt: "2026-01-01T00:00:00Z" }),
			s({ collabId: "new", workflowStatus: "running", workflowCreatedAt: "2026-05-01T00:00:00Z" }),
			s({ collabId: "mid", workflowStatus: "running", workflowCreatedAt: "2026-03-01T00:00:00Z" }),
		]);
		expect(out.active.map((x) => x.collabId)).toEqual(["new", "mid", "old"]);
	});

	it("idle/manual sort falls back to lastActivityAt desc", () => {
		const out = partitionWallGroups([
			s({
				collabId: "a",
				workflowId: null,
				workflowStatus: null,
				workflowType: null,
				workflowCreatedAt: null,
				lastActivityAt: "2026-05-20T00:00:00Z",
			}),
			s({
				collabId: "b",
				workflowId: null,
				workflowStatus: null,
				workflowType: null,
				workflowCreatedAt: null,
				lastActivityAt: "2026-05-25T00:00:00Z",
			}),
		]);
		expect(out.idleManual.map((x) => x.collabId)).toEqual(["b", "a"]);
	});

	it("pins stuck-running rows to the front of ACTIVE, then recency among each subgroup", () => {
		const out = partitionWallGroups([
			s({
				collabId: "ok-old",
				workflowStatus: "running",
				workflowCreatedAt: "2026-01-01T00:00:00Z",
				chainStatus: "active",
			}),
			s({
				collabId: "stuck-new",
				workflowStatus: "running",
				workflowCreatedAt: "2026-05-01T00:00:00Z",
				chainStatus: "escalated",
			}),
			s({
				collabId: "stuck-old",
				workflowStatus: "running",
				workflowCreatedAt: "2026-02-01T00:00:00Z",
				chainStatus: "escalated",
			}),
			s({
				collabId: "ok-new",
				workflowStatus: "running",
				workflowCreatedAt: "2026-04-01T00:00:00Z",
				chainStatus: "active",
			}),
		]);
		expect(out.active.map((x) => x.collabId)).toEqual([
			"stuck-new",
			"stuck-old", // stuck block first, recent first
			"ok-new",
			"ok-old", // non-stuck block, recent first
		]);
	});

	it("never emits a paused group (paused deferred)", () => {
		const out = partitionWallGroups([
			// Defensive: even if upstream surfaces a paused row, it must not appear on the Wall.
			s({ collabId: "p", workflowStatus: "running" }), // proxy for sanity
		]);
		expect((out as Record<string, unknown>).paused).toBeUndefined();
	});
});

describe("allocateWallSections", () => {
	function activeCollab(id: string, createdAt: string): CollabSummary {
		return s({ collabId: id, workflowStatus: "running", workflowCreatedAt: createdAt });
	}
	function doneCollab(id: string, createdAt: string): CollabSummary {
		return s({ collabId: id, workflowStatus: "done", workflowCreatedAt: createdAt });
	}

	it("emits a section per non-empty group, in order, with counts", () => {
		const groups = partitionWallGroups([
			activeCollab("a1", "2026-05-25T00:00:00Z"),
			doneCollab("d1", "2026-05-24T00:00:00Z"),
		]);
		const out = allocateWallSections({ groups, cols: 80, rows: 40, page: 0 });
		expect(out.sections.map((s) => s.group)).toEqual(["active", "doneCanceled"]);
		expect(out.sections[0]!.label).toBe("ACTIVE (1)");
		expect(out.sections[0]!.cardKind).toBe("full");
		expect(out.sections[1]!.cardKind).toBe("compact");
		expect(out.totalRuns).toBe(2);
	});

	it("ACTIVE fills first; DONE only appears when there is room left for its header + at least one card row", () => {
		// Geometry: cols=80 → colsCount=2; full card height=6; compact card height=4;
		// header rows=1 per non-empty section.
		const groups = partitionWallGroups([
			...Array.from({ length: 10 }, (_, i) =>
				activeCollab(`a${i}`, `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
			),
			...Array.from({ length: 10 }, (_, i) =>
				doneCollab(`d${i}`, `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
			),
		]);

		// Tight: rows=20. ACTIVE consumes 1 (header) + 3 rows × 6 = 19 rows for
		// 6 active cards; 1 row remains, less than the 5 rows DONE needs.
		const tight = allocateWallSections({ groups, cols: 80, rows: 20, page: 0 });
		const tightActive = tight.sections.find((s) => s.group === "active")!;
		expect(tightActive.cards.length).toBe(6);
		expect(tight.sections.find((s) => s.group === "doneCanceled")).toBeUndefined();

		// Looser: rows=24. ACTIVE still consumes 19; 5 rows remain → 1-header + 1-row (4) = 5 budget → 1 compact row × 2 cols = 2 cards.
		const loose = allocateWallSections({ groups, cols: 80, rows: 24, page: 0 });
		const looseActive = loose.sections.find((s) => s.group === "active")!;
		expect(looseActive.cards.length).toBe(6);
		const looseDone = loose.sections.find((s) => s.group === "doneCanceled");
		expect(looseDone).toBeDefined();
		expect(looseDone!.cards.length).toBe(2);
	});

	it("paging keeps section order; section headers repeat on later pages", () => {
		const groups = partitionWallGroups(
			Array.from({ length: 20 }, (_, i) =>
				activeCollab(`a${i}`, `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
			),
		);
		const p0 = allocateWallSections({ groups, cols: 80, rows: 14, page: 0 });
		const p1 = allocateWallSections({ groups, cols: 80, rows: 14, page: 1 });
		expect(p0.sections[0]!.group).toBe("active");
		expect(p1.sections[0]!.group).toBe("active");
		expect(p0.pageCount).toBeGreaterThan(1);
		expect(p1.page).toBe(1);
		const ids0 = p0.sections[0]!.cards.map((c) => c.collabId);
		const ids1 = p1.sections[0]!.cards.map((c) => c.collabId);
		expect(ids0.some((id) => ids1.includes(id))).toBe(false);
	});

	it("never produces a header for a section with zero cards", () => {
		const groups = partitionWallGroups([activeCollab("a1", "2026-05-25T00:00:00Z")]);
		const out = allocateWallSections({ groups, cols: 80, rows: 40, page: 0 });
		expect(out.sections.find((s) => s.cards.length === 0)).toBeUndefined();
	});

	it("paused never appears as a section group", () => {
		const paused = {
			...s({ collabId: "p", workflowStatus: "running" }),
			workflowStatus: "paused" as unknown as null,
		} as CollabSummary;
		const groups = partitionWallGroups([paused]);
		const out = allocateWallSections({ groups, cols: 80, rows: 40, page: 0 });
		expect(out.sections.map((s) => s.group)).not.toContain("paused" as never);
	});
});
