import { describe, expect, it } from "vitest";
import { estimateTokens } from "../packages/cli/src/runtime/dashboard-state.ts";
import { buildWallState, selectWallPage } from "../packages/cli/src/runtime/dashboard-state.ts";
import { buildInspectorState } from "../packages/cli/src/runtime/dashboard-state.ts";
import type { CollabSummary } from "@ai-whisper/broker";
import type { RunCostRow } from "@ai-whisper/broker";
import type { PhaseRunRef, RelayHandoffLogRow } from "../packages/cli/src/runtime/dashboard-state.ts";

describe("estimateTokens", () => {
	it("is ceil(chars / 4), deterministic, zero for empty/negative", () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(1)).toBe(1);
		expect(estimateTokens(4)).toBe(1);
		expect(estimateTokens(5)).toBe(2);
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(-10)).toBe(0);
		expect(estimateTokens(Number.NaN)).toBe(0);
	});
});

function sum(p: Partial<CollabSummary>): CollabSummary {
	return {
		collabId: "c", label: "lbl", workspaceRoot: "/tmp/ws", workflowId: "wf", workflowType: "spec-driven-development",
		workflowStatus: "running", currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
		currentRound: 2, maxRounds: 5, chainStatus: "active",
		turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
		sessions: [{ agentType: "codex", healthState: "healthy" }, { agentType: "claude", healthState: "healthy" }],
		workflowCreatedAt: "2026-05-20T00:00:00.000Z",
		specPath: null,
		lastActivityAt: "2026-05-20T00:00:00.000Z", ...p,
	};
}
const emptySnap = { handoffs: [], phaseRuns: [], totalPhases: 4 };

describe("buildWallState", () => {
	it("sections sort ACTIVE (stuck-pinned) → IDLE/MANUAL → DONE; recency desc within each", () => {
		const summaries = [
			sum({ collabId: "done", workflowStatus: "done", chainStatus: "done", workflowCreatedAt: "2026-05-20T00:09:00.000Z" }),
			sum({ collabId: "idle", workflowStatus: null, chainStatus: null, workflowId: null, workflowCreatedAt: null, lastActivityAt: "2026-05-20T00:08:00.000Z" }),
			sum({ collabId: "stuckA", chainStatus: "escalated", workflowCreatedAt: "2026-05-20T00:01:00.000Z" }),
			sum({ collabId: "active", workflowStatus: "running", chainStatus: "active", workflowCreatedAt: "2026-05-20T00:07:00.000Z" }),
			sum({ collabId: "stuckB", chainStatus: "escalated", workflowCreatedAt: "2026-05-20T00:05:00.000Z" }),
		];
		const snapshots = Object.fromEntries(summaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({ summaries, now: "2026-05-20T00:10:00.000Z", idleThresholdMs: 30000, capacity: 10, page: 0, selected: 0, snapshots });
		// ACTIVE: stuck-pinned first by recency desc (stuckB > stuckA), then active.
		// IDLE/MANUAL: idle. DONE/CANCELED: done.
		expect(w.panes.map((p) => p.collabId)).toEqual([
			"stuckB",
			"stuckA",
			"active",
			"idle",
			"done",
		]);
		expect(w.sections.map((s) => s.group)).toEqual([
			"active",
			"idleManual",
			"doneCanceled",
		]);
		expect(w.totalRuns).toBe(5);
		expect(w.pageCount).toBe(1);
	});

	it("paginates to capacity and clamps page + selected", () => {
		const summaries = Array.from({ length: 5 }, (_, i) =>
			sum({ collabId: `c${i}`, lastActivityAt: `2026-05-20T00:0${9 - i}:00.000Z` }),
		);
		const snapshots = Object.fromEntries(summaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({ summaries, now: "2026-05-20T00:10:00.000Z", idleThresholdMs: 30000, capacity: 2, page: 9, selected: 9, snapshots });
		expect(w.pageCount).toBe(3);
		expect(w.page).toBe(2);
		expect(w.panes).toHaveLength(1);
		expect(w.selected).toBe(0);
	});

	it("projects a visible pane via buildRelayViewState (structured fields)", () => {
		const s = sum({ collabId: "c1", label: "oauth", workflowType: "spec-driven-development", phaseIndex: 1, currentRound: 3, maxRounds: 5 });
		const snapshots = {
			c1: {
				handoffs: [
					{ handoffId: "h1", createdAt: "2026-05-20T00:00:00.000Z", collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 3, handoffStep: "review", workflowId: "wf", phaseRunId: "pr1", handbackText: "did x", evaluatorVerdict: "findings", evaluatorConfidence: 0.5, evaluatorReason: "n", lastActivityAt: "2026-05-20T00:00:00.000Z" },
				] as RelayHandoffLogRow[],
				phaseRuns: [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }] as PhaseRunRef[],
				totalPhases: 4,
			},
		};
		const w = buildWallState({ summaries: [s], now: "2026-05-20T00:00:08.000Z", idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots });
		const p = w.panes[0]!;
		expect(p.label).toBe("oauth");
		expect(p.workflowType).toBe("spec-driven-development");
		expect(p.progress).toEqual({ current: 2, total: 4 });
		expect(p.round).toEqual({ current: 3, max: 5 });
		expect(p.events.length).toBeLessThanOrEqual(2);
	});

	it("manual-relay summary → idle status, no round/progress", () => {
		const s = sum({ collabId: "m", label: "Manual", workflowId: null, workflowType: null, workflowStatus: null, currentPhaseRunId: null, phaseIndex: null, phaseName: null, currentRound: null, maxRounds: null, chainStatus: null });
		const w = buildWallState({ summaries: [s], now: "2026-05-20T00:00:01.000Z", idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots: { m: emptySnap } });
		const p = w.panes[0]!;
		expect(p.label).toBe("Manual");
		expect(p.workflowType).toBeNull();
		expect(p.statusKey).toBe("idle");
		expect(p.round).toBeNull();
	});

	it("selected clamps across all visible sections", () => {
		const summaries = [
			sum({ collabId: "a", workflowStatus: "running", workflowCreatedAt: "2026-05-20T00:05:00.000Z" }),
			sum({ collabId: "d", workflowStatus: "done", workflowCreatedAt: "2026-05-20T00:04:00.000Z" }),
		];
		const snapshots = Object.fromEntries(summaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({
			summaries,
			now: "2026-05-20T00:10:00.000Z",
			idleThresholdMs: 30000,
			cols: 80,
			rows: 40,
			page: 0,
			selected: 99,
			snapshots,
		});
		// 2 panes total across two sections; clamping should pin selected to last index.
		expect(w.panes.length).toBe(2);
		expect(w.selected).toBe(1);
	});

	it("buildWallState emits structured WallPaneState fields per pane", () => {
		const now = "2026-05-20T00:01:00.000Z";
		const summaries = [sum({ collabId: "c1" })];
		const state = buildWallState({
			summaries,
			now,
			idleThresholdMs: 60_000,
			capacity: 10,
			page: 0,
			selected: 0,
			snapshots: { c1: { handoffs: [], phaseRuns: [], totalPhases: 5 } },
		});
		const pane = state.panes[0]!;
		expect(pane.collabId).toBe("c1");
		expect(pane.statusKey).toBe("running");
		expect(pane.label).toBe("lbl");
		expect(pane.workflowType).toBe("spec-driven-development");
		expect(pane.round).toEqual({ current: 2, max: 5 });
		expect(pane.progress).toEqual({ current: 2, total: 5 }); // phaseIndex 1-based current
		expect(pane.agentHealth).toEqual([
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		]);
		expect(pane.cardKind).toBe("full"); // running → ACTIVE group → full card
		expect(pane.events.length).toBeLessThanOrEqual(2);
		expect(pane.stuckWhy).toBeNull();
	});

	it("empty summaries → empty wall", () => {
		const w = buildWallState({ summaries: [], now: "2026-05-20T00:00:00.000Z", idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots: {} });
		expect(w).toMatchObject({ panes: [], page: 0, pageCount: 0, totalRuns: 0, selected: 0 });
	});

	it("projects startIso (workflowCreatedAt) and artifact (specPath) onto the pane", () => {
		const s = sum({
			collabId: "c1",
			workflowCreatedAt: "2026-05-20T00:00:00.000Z",
			specPath: "docs/specs/foo-design.md",
		});
		const w = buildWallState({
			summaries: [s],
			now: "2026-05-20T00:01:00.000Z",
			idleThresholdMs: 60_000,
			capacity: 10,
			page: 0,
			selected: 0,
			snapshots: { c1: emptySnap },
		});
		const pane = w.panes[0]!;
		expect(pane.startIso).toBe("2026-05-20T00:00:00.000Z");
		expect(pane.artifact).toBe("docs/specs/foo-design.md");
	});

	it("manual-relay pane has null startIso and artifact", () => {
		const s = sum({
			collabId: "m",
			workflowId: null,
			workflowType: null,
			workflowStatus: null,
			currentPhaseRunId: null,
			phaseIndex: null,
			phaseName: null,
			currentRound: null,
			maxRounds: null,
			chainStatus: null,
			workflowCreatedAt: null,
			specPath: null,
		});
		const w = buildWallState({
			summaries: [s],
			now: "2026-05-20T00:01:00.000Z",
			idleThresholdMs: 60_000,
			capacity: 10,
			page: 0,
			selected: 0,
			snapshots: { m: emptySnap },
		});
		const pane = w.panes[0]!;
		expect(pane.startIso).toBeNull();
		expect(pane.artifact).toBeNull();
	});

	// Bug C / Task 8b: the Wall path must feed the active step into the liveness
	// snapshot so the phase-aware budget applies on the Wall too (the pane still
	// renders P/R only). An execute step idle over the 5-min baseline but under
	// the 10-min budget, with the active agent alive, must read NOT stuck.
	it("Wall uses the phase-aware budget: execute step idle 6m with a DEAD active mount → not stuck (10m budget, baseline would have STUCK)", () => {
		const now = "2026-05-20T00:06:00.000Z";
		// Active mount DEAD: if the Wall used the 5-min baseline (currentStep null)
		// this would be STUCK at 6m. The 10-min execute budget keeps it not-stuck,
		// proving the active step is fed into the liveness snapshot.
		const s = sum({
			collabId: "c1", workflowType: "spec-driven-development", phaseIndex: 1,
			currentRound: 1, maxRounds: 1, chainStatus: "active",
			turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
			sessions: [
				{ agentType: "codex", healthState: "healthy", mountAlive: false },
				{ agentType: "claude", healthState: "healthy", mountAlive: true },
			],
			lastActivityAt: "2026-05-20T00:00:00.000Z", // idle 6m
		});
		const snapshots = {
			c1: {
				handoffs: [
					{ handoffId: "h1", createdAt: "2026-05-20T00:00:00.000Z", collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "execute", workflowId: "wf", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "ok", evaluatorConfidence: 0.9, evaluatorReason: "n", lastActivityAt: "2026-05-20T00:00:00.000Z" },
				] as RelayHandoffLogRow[],
				phaseRuns: [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-execution", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }] as PhaseRunRef[],
				totalPhases: 4,
			},
		};
		const w = buildWallState({ summaries: [s], now, idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots });
		expect(w.panes[0]!.statusKey).not.toBe("stuck");
	});

	it("Wall control: non-execute step idle past baseline with dead active mount → stuck (baseline applies)", () => {
		const now = "2026-05-20T00:06:00.000Z";
		const s = sum({
			collabId: "c2", workflowType: "spec-driven-development", phaseIndex: 1,
			currentRound: 1, maxRounds: 1, chainStatus: "active",
			turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
			sessions: [
				{ agentType: "codex", healthState: "healthy", mountAlive: false },
				{ agentType: "claude", healthState: "healthy", mountAlive: true },
			],
			lastActivityAt: "2026-05-20T00:00:00.000Z", // idle 6m ≥ 5m baseline
		});
		const snapshots = {
			c2: {
				handoffs: [
					{ handoffId: "h1", createdAt: "2026-05-20T00:00:00.000Z", collabId: "c2", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "ack", workflowId: "wf", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "ok", evaluatorConfidence: 0.9, evaluatorReason: "n", lastActivityAt: "2026-05-20T00:00:00.000Z" },
				] as RelayHandoffLogRow[],
				phaseRuns: [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }] as PhaseRunRef[],
				totalPhases: 4,
			},
		};
		const w = buildWallState({ summaries: [s], now, idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots });
		expect(w.panes[0]!.statusKey).toBe("stuck");
	});
});

describe("selectWallPage", () => {
	it("sorts + paginates WITHOUT needing snapshots; returns only the page's summaries", () => {
		const summaries = [
			sum({ collabId: "done", workflowStatus: "done", chainStatus: "done", lastActivityAt: "2026-05-20T00:09:00.000Z" }),
			sum({ collabId: "stuckA", chainStatus: "escalated", lastActivityAt: "2026-05-20T00:01:00.000Z" }),
			sum({ collabId: "active", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:07:00.000Z" }),
			sum({ collabId: "stuckB", chainStatus: "escalated", lastActivityAt: "2026-05-20T00:05:00.000Z" }),
		];
		const p0 = selectWallPage({ summaries, capacity: 2, page: 0, selected: 0 });
		expect(p0.pageSummaries.map((s) => s.collabId)).toEqual(["stuckB", "stuckA"]);
		expect(p0).toMatchObject({ page: 0, pageCount: 2, totalRuns: 4, selected: 0 });
		const p9 = selectWallPage({ summaries, capacity: 2, page: 9, selected: 9 });
		expect(p9.page).toBe(1);
		expect(p9.pageSummaries.map((s) => s.collabId)).toEqual(["active", "done"]);
		expect(p9.selected).toBe(1);
	});
	it("buildWallState selects the SAME page as selectWallPage (single-sourced)", () => {
		const summaries = Array.from({ length: 5 }, (_, i) =>
			sum({ collabId: `c${i}`, lastActivityAt: `2026-05-20T00:0${9 - i}:00.000Z` }),
		);
		const sel = selectWallPage({ summaries, capacity: 2, page: 1, selected: 0 });
		const snapshots = Object.fromEntries(sel.pageSummaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({ summaries, now: "2026-05-20T00:10:00.000Z", idleThresholdMs: 30000, capacity: 2, page: 1, selected: 0, snapshots });
		expect(w.panes.map((p) => p.collabId)).toEqual(sel.pageSummaries.map((s) => s.collabId));
	});
	it("treats empty lastActivityAt (fresh running run, no handoffs) as most-recent within its rank", () => {
		const summaries = [
			sum({ collabId: "old", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:01:00.000Z" }),
			sum({ collabId: "fresh", workflowStatus: "running", chainStatus: "active", lastActivityAt: "" }),
		];
		const sel = selectWallPage({ summaries, capacity: 10, page: 0, selected: 0 });
		expect(sel.pageSummaries.map((s) => s.collabId)).toEqual(["fresh", "old"]);
	});
	it("ranks workflowStatus halted/canceled as stuck (the non-chainStatus OR branch)", () => {
		const summaries = [
			sum({ collabId: "active", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:09:00.000Z" }),
			sum({ collabId: "halted", workflowStatus: "halted", chainStatus: "active", lastActivityAt: "2026-05-20T00:02:00.000Z" }),
			sum({ collabId: "canceled", workflowStatus: "canceled", chainStatus: "active", lastActivityAt: "2026-05-20T00:05:00.000Z" }),
		];
		const sel = selectWallPage({ summaries, capacity: 10, page: 0, selected: 0 });
		// halted+canceled are stuck (rank 0) → before the active run; among the
		// two stuck, lastActivity desc → canceled (00:05) before halted (00:02).
		expect(sel.pageSummaries.map((s) => s.collabId)).toEqual(["canceled", "halted", "active"]);
	});
});

const liveSnap = {
	now: "2026-05-20T00:15:00.000Z", idleThresholdMs: 30000,
	workflow: { workflowId: "wf", workflowType: "spec-driven-development", name: "x", status: "running" as const, createdAt: "2026-05-20T00:00:00.000Z", haltReason: null },
	phaseRuns: [], currentPhaseRunId: "pr2", currentStep: null, totalPhases: 4,
	chain: { currentRound: 5, maxRounds: 5, status: "escalated" as const },
	turn: { turnOwner: "codex" as const, waitingAgent: "claude" as const, handoffState: "accepted" },
	sessions: [{ agentType: "codex", healthState: "healthy" }], lastActivityAt: "2026-05-20T00:14:00.000Z", handoffs: [],
};

describe("buildInspectorState — timeline + cost", () => {
	it("computes per-phase duration, rounds vs max, est tokens, and totals", () => {
		const phaseRuns: PhaseRunRef[] = [
			{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining", startedAt: "2026-05-20T00:00:00.000Z", endedAt: "2026-05-20T00:03:00.000Z", outcome: "done" },
			{ phaseRunId: "pr2", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:03:00.000Z", endedAt: null, outcome: null },
		];
		const costRows: RunCostRow[] = [
			{ phaseRunId: "pr1", createdAt: "2026-05-20T00:00:00.000Z", resolvedAt: "2026-05-20T00:03:00.000Z", lastActivityAt: "2026-05-20T00:03:00.000Z", inChars: 4000, outChars: 800 },
			{ phaseRunId: "pr2", createdAt: "2026-05-20T00:04:00.000Z", resolvedAt: null, lastActivityAt: "2026-05-20T00:14:00.000Z", inChars: 8000, outChars: 1200 },
		];
		const s = buildInspectorState({
			snapshot: liveSnap, phaseRuns, phaseMaxRounds: { 0: 5, 1: 5 }, costRows,
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch1",
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr2",
		});
		expect(s.live.health).toContain("Chain escalated");
		expect(s.timeline).toHaveLength(2);
		expect(s.timeline[0]).toMatchObject({ phaseName: "spec-refining", maxRounds: 5, durationMs: 180000, outcome: "done", estInTokens: 1000, estOutTokens: 200 });
		expect(s.timeline[1]).toMatchObject({ phaseName: "plan-writing", durationMs: null, estInTokens: 2000, estOutTokens: 300 });
		expect(s.cost.estInputTokens).toBe(3000);
		expect(s.cost.estOutputTokens).toBe(500);
		expect(s.cost.totalMs).toBe(Date.parse("2026-05-20T00:14:00.000Z") - Date.parse("2026-05-20T00:00:00.000Z"));
		expect(s.cost.perPhase.map((p) => p.phaseName)).toEqual(["spec-refining", "plan-writing"]);
	});

	it("manual-relay (no workflowCreatedAt) → totalMs from min createdAt; timeline empty", () => {
		const costRows: RunCostRow[] = [
			{ phaseRunId: null, createdAt: "2026-05-20T00:02:00.000Z", resolvedAt: null, lastActivityAt: "2026-05-20T00:06:00.000Z", inChars: 40, outChars: 4 },
		];
		const s = buildInspectorState({
			snapshot: { ...liveSnap, workflow: null }, phaseRuns: [], phaseMaxRounds: {}, costRows,
			workflowCreatedAt: null, chainId: null, evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: null,
		});
		expect(s.timeline).toEqual([]);
		expect(s.cost.totalMs).toBe(Date.parse("2026-05-20T00:06:00.000Z") - Date.parse("2026-05-20T00:02:00.000Z"));
		expect(s.cost.estInputTokens).toBe(10);
	});

	it("no cost rows → zero totals, no NaN", () => {
		const s = buildInspectorState({
			snapshot: liveSnap, phaseRuns: [], phaseMaxRounds: {}, costRows: [],
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: null, evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: null,
		});
		expect(s.cost).toMatchObject({ totalMs: 0, estInputTokens: 0, estOutputTokens: 0, perPhase: [] });
	});

	it("roundsUsed = max roundNumber per phaseRun from snapshot.handoffs (null phase/round ignored); maxRounds from phaseMaxRounds", () => {
		const phaseRuns: PhaseRunRef[] = [
			{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining", startedAt: "2026-05-20T00:00:00.000Z", endedAt: "2026-05-20T00:03:00.000Z", outcome: "done" },
			{ phaseRunId: "pr2", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:03:00.000Z", endedAt: null, outcome: null },
		];
		const hs = [
			{ handoffId: "a", createdAt: "2026-05-20T00:01:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch", roundNumber: 1, handoffStep: "review", workflowId: "wf", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "approve", evaluatorConfidence: 0.9, evaluatorReason: null, lastActivityAt: "2026-05-20T00:01:00.000Z" },
			{ handoffId: "b", createdAt: "2026-05-20T00:02:00.000Z", collabId: "c", senderAgent: "claude", targetAgent: "codex", status: "handed_back", captureStatus: "ok", chainId: "ch", roundNumber: 2, handoffStep: "fix", workflowId: "wf", phaseRunId: "pr1", handbackText: "y", evaluatorVerdict: "findings", evaluatorConfidence: 0.4, evaluatorReason: null, lastActivityAt: "2026-05-20T00:02:00.000Z" },
			{ handoffId: "c", createdAt: "2026-05-20T00:05:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch", roundNumber: 4, handoffStep: "review", workflowId: "wf", phaseRunId: "pr2", handbackText: "z", evaluatorVerdict: "findings", evaluatorConfidence: 0.3, evaluatorReason: null, lastActivityAt: "2026-05-20T00:05:00.000Z" },
			{ handoffId: "d", createdAt: "2026-05-20T00:06:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "pending", captureStatus: null, chainId: null, roundNumber: null, handoffStep: null, workflowId: null, phaseRunId: null, handbackText: null, evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null, lastActivityAt: "2026-05-20T00:06:00.000Z" },
		] as RelayHandoffLogRow[];
		const s = buildInspectorState({
			snapshot: { ...liveSnap, handoffs: hs },
			phaseRuns, phaseMaxRounds: { 0: 5, 1: 3 }, costRows: [],
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch",
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr2",
		});
		expect(s.timeline.map((t) => ({ p: t.phaseName, used: t.roundsUsed, max: t.maxRounds }))).toEqual([
			{ p: "spec-refining", used: 2, max: 5 }, // max(round 1, round 2) for pr1
			{ p: "plan-writing", used: 4, max: 3 },  // round 4 for pr2; null-phase/round handoff "d" ignored
		]);
	});
});

describe("buildInspectorState — workflow history (Bug B)", () => {
	const phaseRuns: PhaseRunRef[] = [
		{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining", startedAt: "2026-05-20T00:00:00.000Z", endedAt: "2026-05-20T00:03:00.000Z", outcome: "done" },
		{ phaseRunId: "pr2", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:03:00.000Z", endedAt: null, outcome: null },
	];
	const workflows = [
		{ workflowId: "wf_new", workflowType: "spec-driven-development", name: "third", status: "running" as const, currentPhaseIndex: 0, createdAt: "2026-05-20T02:00:00.000Z" },
		{ workflowId: "wf_old", workflowType: "spec-driven-development", name: "first", status: "done" as const, currentPhaseIndex: 2, createdAt: "2026-05-20T00:00:00.000Z" },
	];

	it("exposes a workflow-history list (newest-first) with the active one flagged selected", () => {
		const s = buildInspectorState({
			snapshot: liveSnap, phaseRuns, phaseMaxRounds: { 0: 5, 1: 5 }, costRows: [],
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch1",
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr2",
			workflows, selectedWorkflowId: "wf_new",
		});
		expect(s.workflowHistory.map((w) => w.workflowId)).toEqual(["wf_new", "wf_old"]);
		expect(s.workflowHistory.map((w) => w.selected)).toEqual([true, false]);
		expect(s.workflowHistory[0]).toMatchObject({ workflowId: "wf_new", status: "running", currentPhaseIndex: 0, name: "third" });
	});

	it("selecting a non-active workflow yields its timeline + flags it selected", () => {
		// Host feeds the SELECTED past workflow's phaseRuns; the timeline builder
		// uses them directly. Here we select wf_old and pass its single phase run.
		const pastPhaseRuns: PhaseRunRef[] = [
			{ phaseRunId: "pr_old", phaseIndex: 0, phaseName: "spec-refining", startedAt: "2026-05-20T00:00:00.000Z", endedAt: "2026-05-20T00:02:00.000Z", outcome: "done" },
		];
		const s = buildInspectorState({
			snapshot: { ...liveSnap, phaseRuns: pastPhaseRuns, currentPhaseRunId: "pr_old" }, phaseRuns: pastPhaseRuns, phaseMaxRounds: { 0: 5 }, costRows: [],
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: null,
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr_old",
			workflows, selectedWorkflowId: "wf_old",
		});
		expect(s.timeline.map((t) => t.phaseName)).toEqual(["spec-refining"]);
		expect(s.timeline[0]).toMatchObject({ durationMs: 120000, outcome: "done" });
		expect(s.workflowHistory.find((w) => w.selected)?.workflowId).toBe("wf_old");
	});

	it("defaults workflowHistory to [] when no workflows passed", () => {
		const s = buildInspectorState({
			snapshot: liveSnap, phaseRuns, phaseMaxRounds: { 0: 5, 1: 5 }, costRows: [],
			workflowCreatedAt: null, chainId: null,
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: null,
		});
		expect(s.workflowHistory).toEqual([]);
	});
});

describe("buildInspectorState — evidence", () => {
	const handoffs: RelayHandoffLogRow[] = [
		{ handoffId: "h1", createdAt: "2026-05-20T00:01:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement", workflowId: "wf", phaseRunId: "pr2", handbackText: "wrote plan", evaluatorVerdict: "delivered", evaluatorConfidence: 0.61, evaluatorReason: "test plan TBD", lastActivityAt: "2026-05-20T00:01:00.000Z" },
		{ handoffId: "h2", createdAt: "2026-05-20T00:05:00.000Z", collabId: "c", senderAgent: "claude", targetAgent: "codex", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 5, handoffStep: "review", workflowId: "wf", phaseRunId: "pr2", handbackText: null, evaluatorVerdict: "findings", evaluatorConfidence: 0.43, evaluatorReason: "criterion 5 still unmet and the scope is ambiguous enough that more rounds will not converge", lastActivityAt: "2026-05-20T00:05:00.000Z" },
	];
	it("builds chain items, diagnostics, and a declining-confidence likely cause", () => {
		const s = buildInspectorState({
			snapshot: { ...liveSnap }, phaseRuns: [{ phaseRunId: "pr2", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }],
			phaseMaxRounds: { 1: 5 }, costRows: [], workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch1",
			evidenceHandoffs: handoffs,
			evaluatorDiags: [
				{ verdict: "delivered", confidence: 0.61, reason: "test plan TBD", outcome: "ok" },
				{ verdict: "findings", confidence: 0.43, reason: "criterion 5 unmet", outcome: "ok" },
			],
			captureDiags: [{ captureStatus: "ok", turnConfidence: "high" }],
			focusedPhaseRunId: "pr2",
		});
		expect(s.evidence.chainId).toBe("ch1");
		expect(s.evidence.items).toHaveLength(2);
		expect(s.evidence.items[1]).toMatchObject({ round: 5, step: "review", verdict: "findings", confidence: 0.43 });
		expect(s.evidence.items[1]!.reasonExcerpt.length).toBeLessThanOrEqual(81);
		expect(s.evidence.diagnostics.some((d) => d.kind === "evaluator")).toBe(true);
		expect(s.evidence.likelyCause).toMatch(/confidence declining|under-specified|maxRounds/);
	});
	it("capture issue drives the likely cause when not escalated", () => {
		const s = buildInspectorState({
			snapshot: { ...liveSnap, chain: { currentRound: 2, maxRounds: 5, status: "active" } },
			phaseRuns: [], phaseMaxRounds: {}, costRows: [], workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch1",
			evidenceHandoffs: handoffs.slice(0, 1),
			evaluatorDiags: [], captureDiags: [{ captureStatus: "no_response_captured", turnConfidence: "low" }],
			focusedPhaseRunId: "pr2",
		});
		expect(s.evidence.likelyCause).toMatch(/capture issues/);
	});
	it("likelyCause branch 3 (stuck, no escalation/capture) and branch 4 (progressing); empty evidenceHandoffs → items []", () => {
		const base = {
			phaseRuns: [], phaseMaxRounds: {}, costRows: [], workflowCreatedAt: "2026-05-20T00:00:00.000Z",
			chainId: "ch1", evidenceHandoffs: [] as RelayHandoffLogRow[],
			evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr2",
		};
		// Branch 3: idle-stuck (now ≫ lastActivityAt), chain active, no capture/declining.
		const stuck = buildInspectorState({
			...base,
			snapshot: { ...liveSnap, now: "2026-05-20T01:00:00.000Z", lastActivityAt: "2026-05-20T00:00:00.000Z", chain: { currentRound: 2, maxRounds: 5, status: "active" } },
		});
		expect(stuck.live.stuck).toBe(true);
		expect(stuck.evidence.items).toEqual([]);
		expect(stuck.evidence.likelyCause).toMatch(/^stuck: /);
		expect(stuck.evidence.likelyCause).not.toMatch(/under-specified|capture issues/);
		// Branch 4: not stuck (idle ~0), chain active round 1.
		const ok = buildInspectorState({
			...base,
			snapshot: { ...liveSnap, now: "2026-05-20T00:14:01.000Z", lastActivityAt: "2026-05-20T00:14:00.000Z", chain: { currentRound: 1, maxRounds: 5, status: "active" } },
		});
		expect(ok.live.stuck).toBe(false);
		expect(ok.evidence.likelyCause).toBe("no blocking signal — run progressing");
		expect(ok.evidence.items).toEqual([]);
	});
});

describe("buildWallState — terminal-card elapsed is frozen across polls", () => {
	function buildAt(now: string, status: "running" | "done" | "halted" | "canceled") {
		const summaries: CollabSummary[] = [
			sum({
				collabId: "c1",
				workflowStatus: status,
				workflowCreatedAt: "2026-05-20T00:00:00.000Z",
				lastActivityAt: "2026-05-20T00:04:12.000Z", // 4m12s run
				chainStatus:
					status === "running" ? "active" : status === "done" ? "done" : "abandoned",
			}),
		];
		return buildWallState({
			summaries,
			now,
			idleThresholdMs: 60_000,
			cols: 80,
			rows: 30,
			page: 0,
			selected: 0,
			snapshots: { c1: { handoffs: [], phaseRuns: [], totalPhases: 5 } },
		});
	}

	function paneOf(state: ReturnType<typeof buildAt>) {
		return state.sections[0]!.panes[0]!;
	}

	it("done card elapsed is identical at two different polling timestamps", () => {
		const t1 = "2026-05-20T00:05:00.000Z"; // 48s after run ended
		const t2 = "2026-05-20T01:00:00.000Z"; // 55m after run ended — clock long past
		const a = paneOf(buildAt(t1, "done"));
		const b = paneOf(buildAt(t2, "done"));
		expect(a.elapsed).toBe(b.elapsed);
		expect(a.elapsed).toBe("4m12s"); // frozen at the actual run duration
	});

	it("canceled and halted also freeze elapsed at lastActivityAt - workflowCreatedAt", () => {
		const t = "2026-05-20T12:00:00.000Z";
		expect(paneOf(buildAt(t, "canceled")).elapsed).toBe("4m12s");
		expect(paneOf(buildAt(t, "halted")).elapsed).toBe("4m12s");
	});

	it("running card elapsed advances as `now` advances (NOT frozen)", () => {
		const a = paneOf(buildAt("2026-05-20T00:05:00.000Z", "running")); // 5m
		const b = paneOf(buildAt("2026-05-20T00:10:00.000Z", "running")); // 10m
		expect(a.elapsed).not.toBe(b.elapsed);
		expect(a.elapsed).toBe("5m00s");
		expect(b.elapsed).toBe("10m00s");
	});
});
