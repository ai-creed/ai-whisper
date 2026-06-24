import { homedir } from "node:os";
import type { AgentType } from "@ai-whisper/shared";
import type {
	LogLine,
	PhaseRunRef,
	RelayViewSnapshot,
	RelayViewState,
} from "./relay-view-state.js";
import { buildRelayViewState, deriveLogLines, fmtDur } from "./relay-view-state.js";
import { statusGlyph } from "./dashboard-glyph.js";
import type {
	CollabSummary,
	RelayHandoffLogRow,
	RunCostRow,
	WorkflowSummaryRow,
} from "@ai-whisper/broker";

export type WallEvent = { step: string; route: string; verdict: string };

export type WallPaneState = {
	collabId: string;
	workflowId: string | null;
	statusKey: "running" | "paused" | "stuck" | "done" | "canceled" | "idle";
	label: string;
	workflowType: string | null;
	round: { current: number; max: number } | null;
	progress: { current: number; total: number } | null;
	agentHealth: Array<{
		agent: AgentType;
		health: "healthy" | "degraded" | "dead";
	}>;
	stuckWhy: string | null;
	events: WallEvent[]; // newest first, length ≤ 2
	elapsed: string; // for compact card line 2
	startIso: string | null; // workflow start (workflowCreatedAt) — UTC HH:MM on the card
	artifact: string | null; // repo-relative spec/goal/bug-report path
	cwd: string | null; // abbreviated workspace_root ($HOME→~), null when unknown
	cardKind: "full" | "compact";
};
export type WallStateSection = {
	group: WallGroupKey;
	label: string;
	cardKind: "full" | "compact";
	panes: WallPaneState[];
};
export type WallState = {
	sections: WallStateSection[];
	// `panes` flat view across all sections in render order — kept for callers
	// that only need a flat list (host snapshot-fetch keys, selection cursor).
	panes: WallPaneState[];
	page: number;
	pageCount: number;
	totalRuns: number;
	selected: number;
};
export type PhaseStat = {
	// Unique per phase RUN (the phase_runs PK). The timeline is a list of runs,
	// and one phaseIndex can recur — escalate→resume opens a fresh run at the same
	// index — so phaseRunId, not phaseIndex, is the stable React list key.
	phaseRunId: string;
	phaseIndex: number;
	phaseName: string;
	roundsUsed: number;
	maxRounds: number;
	durationMs: number | null;
	outcome: string | null;
	estInTokens: number;
	estOutTokens: number;
};
export type EvidenceItem = {
	round: number | null;
	step: string | null;
	sender: string;
	target: string;
	verdict: string | null;
	confidence: number | null;
	reasonExcerpt: string;
	captureStatus: string | null;
};
export type DiagItem = { kind: "evaluator" | "capture"; text: string };
export type CostSummary = {
	totalMs: number;
	estInputTokens: number;
	estOutputTokens: number;
	perPhase: Array<{
		phaseRunId: string | null;
		phaseName: string;
		estInTokens: number;
		estOutTokens: number;
		durationMs: number | null;
	}>;
};
export type WorkflowHistoryItem = {
	workflowId: string;
	workflowType: string;
	name: string | null;
	status: "running" | "paused" | "done" | "halted" | "canceled";
	currentPhaseIndex: number;
	createdAt: string;
	selected: boolean;
};
export type InspectorState = {
	live: RelayViewState;
	timeline: PhaseStat[];
	// Bug B: full workflow run history for the inspected collab (newest-first).
	// The `selected` flag marks which workflow the timeline/evidence currently
	// reflect. Empty when no workflows were passed.
	workflowHistory: WorkflowHistoryItem[];
	evidence: {
		phase: string | null;
		chainId: string | null;
		items: EvidenceItem[];
		diagnostics: DiagItem[];
		likelyCause: string;
	};
	cost: CostSummary;
};

// v1 token estimate — labeled "≈ est, not metered" at the UI layer.
export function estimateTokens(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return Math.ceil(chars / 4);
}

// Re-export the reused pure helpers so later tasks/tests import from one place.
export { buildRelayViewState, deriveLogLines, fmtDur };
export type { LogLine, PhaseRunRef, RelayViewSnapshot, RelayViewState, RelayHandoffLogRow, CollabSummary, RunCostRow };

// ---- Group partition + recency sort + stuck-pin (spec: Wall grouping) ----

export type WallGroupKey = "active" | "idleManual" | "halted" | "doneCanceled";

export type WallGroups = {
	active: CollabSummary[];
	idleManual: CollabSummary[];
	halted: CollabSummary[];
	doneCanceled: CollabSummary[];
};

function isStuckRunning(s: CollabSummary): boolean {
	// Wall-side static stuck signal — full liveness lives in computeLiveness,
	// but for ordering we only need the chain-derived signal that survives a
	// running workflowStatus.
	return (
		s.workflowStatus === "running" &&
		(s.chainStatus === "escalated" ||
			s.chainStatus === "abandoned" ||
			(s.currentRound != null &&
				s.maxRounds != null &&
				s.maxRounds > 1 &&
				s.currentRound >= s.maxRounds))
	);
}

function recencyKey(s: CollabSummary): string {
	return s.workflowCreatedAt ?? s.lastActivityAt ?? "";
}

function cmpDesc(a: string, b: string): number {
	return a < b ? 1 : a > b ? -1 : 0;
}

// Abbreviate an absolute workspace path for the card: strip a leading /private
// (macOS tmp/var symlink), then replace a leading $HOME with ~. Pure — `home`
// is injected. Returns "" unchanged (caller maps that to null).
export function abbreviateCwd(absPath: string, home: string): string {
	let p = absPath;
	if (p.startsWith("/private/")) p = p.slice("/private".length);
	if (home && (p === home || p.startsWith(home + "/"))) p = "~" + p.slice(home.length);
	return p;
}

// A Wall pane represents ONE run: a workflow instance (keyed by workflowId) or a
// manual-relay slice (no workflow → keyed by collabId). `--all` can place two
// runs of the SAME collab on screen, so snapshot/pane identity keys off the run,
// not the collab, or sibling runs collide.
export function runKey(s: { workflowId: string | null; collabId: string }): string {
	return s.workflowId ?? s.collabId;
}

export function partitionWallGroups(summaries: CollabSummary[]): WallGroups {
	const active: CollabSummary[] = [];
	const idleManual: CollabSummary[] = [];
	const halted: CollabSummary[] = [];
	const doneCanceled: CollabSummary[] = [];
	for (const s of summaries) {
		if (s.workflowStatus === null) idleManual.push(s);
		else if (s.workflowStatus === "running" || s.workflowStatus === "paused")
			active.push(s);
		else if (s.workflowStatus === "halted") halted.push(s);
		else if (s.workflowStatus === "done" || s.workflowStatus === "canceled")
			doneCanceled.push(s);
		// Any unknown future status is dropped (defensive).
	}
	// ACTIVE: stuck-pin (stuck block first), then recency desc within each block.
	active.sort((a, b) => {
		const sa = isStuckRunning(a) ? 0 : 1;
		const sb = isStuckRunning(b) ? 0 : 1;
		if (sa !== sb) return sa - sb;
		return cmpDesc(recencyKey(a), recencyKey(b));
	});
	// Other groups: recency desc.
	idleManual.sort((a, b) => cmpDesc(recencyKey(a), recencyKey(b)));
	halted.sort((a, b) => cmpDesc(recencyKey(a), recencyKey(b)));
	doneCanceled.sort((a, b) => cmpDesc(recencyKey(a), recencyKey(b)));
	return { active, idleManual, halted, doneCanceled };
}

export type WallSummaryCounts = {
	running: number;
	paused: number;
	stuck: number;
	done: number;
	canceled: number;
	idle: number;
};

// Page-independent, snapshot-free counts for the Wall summary bar. Derived only
// from workflowStatus + the cheap Wall-side isStuckRunning signal (the same one
// that drives stuck-pinning), so it can count the FULL visible scope without
// fetching per-run snapshots. `stuck` is evaluated before `running` so a running
// workflow flagged by isStuckRunning counts once, as stuck.
export function summarizeWall(summaries: CollabSummary[]): WallSummaryCounts {
	const counts: WallSummaryCounts = {
		running: 0,
		paused: 0,
		stuck: 0,
		done: 0,
		canceled: 0,
		idle: 0,
	};
	for (const s of summaries) {
		const st = s.workflowStatus;
		if (st === null) counts.idle++;
		else if (st === "halted") counts.stuck++;
		else if (st === "running") {
			if (isStuckRunning(s)) counts.stuck++;
			else counts.running++;
		} else if (st === "paused") counts.paused++;
		else if (st === "done") counts.done++;
		else if (st === "canceled") counts.canceled++;
		// Unknown future status: not counted (defensive, mirrors partitionWallGroups).
	}
	return counts;
}

// ---- Priority-fill allocation + paging across sections ----

const MIN_PANE_COLS = 40;
export const CARD_HEIGHT = { full: 7, compact: 5 } as const; // border (2) + content
const HEADER_ROWS = 1;

const GROUP_ORDER: WallGroupKey[] = ["active", "idleManual", "halted", "doneCanceled"];
const GROUP_LABEL: Record<WallGroupKey, string> = {
	active: "ACTIVE",
	idleManual: "IDLE / MANUAL",
	halted: "HALTED",
	doneCanceled: "DONE / CANCELED",
};

export type WallSection = {
	group: WallGroupKey;
	label: string;
	cardKind: "full" | "compact";
	cards: CollabSummary[];
};

export type WallSectionsResult = {
	sections: WallSection[];
	page: number;
	pageCount: number;
	totalRuns: number;
};

function cardKindFor(group: WallGroupKey): "full" | "compact" {
	return group === "active" ? "full" : "compact";
}

function fillOnePage(input: {
	pools: Record<WallGroupKey, CollabSummary[]>;
	cols: number;
	rows: number;
}): { sections: WallSection[]; consumed: Record<WallGroupKey, number> } {
	const colsCount = Math.max(1, Math.floor(input.cols / MIN_PANE_COLS));
	let rowsLeft = input.rows;
	const consumed: Record<WallGroupKey, number> = {
		active: 0,
		idleManual: 0,
		halted: 0,
		doneCanceled: 0,
	};
	const sections: WallSection[] = [];
	for (const group of GROUP_ORDER) {
		const pool = input.pools[group];
		if (pool.length === 0) continue;
		if (rowsLeft <= HEADER_ROWS) break;
		const cardKind = cardKindFor(group);
		const cardRows = CARD_HEIGHT[cardKind];
		const availableForCards = rowsLeft - HEADER_ROWS;
		const cardRowsFit = Math.floor(availableForCards / cardRows);
		if (cardRowsFit === 0) break;
		const cap = cardRowsFit * colsCount;
		const taken = pool.slice(0, Math.min(cap, pool.length));
		if (taken.length === 0) break;
		const rowsTaken = HEADER_ROWS + Math.ceil(taken.length / colsCount) * cardRows;
		rowsLeft -= rowsTaken;
		consumed[group] = taken.length;
		sections.push({
			group,
			label: `${GROUP_LABEL[group]} (${pool.length})`,
			cardKind,
			cards: taken,
		});
	}
	return { sections, consumed };
}

export function allocateWallSections(input: {
	groups: WallGroups;
	cols: number;
	rows: number;
	page: number;
}): WallSectionsResult {
	const totalRuns =
		input.groups.active.length +
		input.groups.idleManual.length +
		input.groups.halted.length +
		input.groups.doneCanceled.length;

	// Walk pages forward until we reach the requested page or run out of cards.
	let pool: Record<WallGroupKey, CollabSummary[]> = {
		active: [...input.groups.active],
		idleManual: [...input.groups.idleManual],
		halted: [...input.groups.halted],
		doneCanceled: [...input.groups.doneCanceled],
	};
	let page = 0;
	let result = fillOnePage({ pools: pool, cols: input.cols, rows: input.rows });
	let lastNonEmpty = result;
	while (page < input.page && result.sections.length > 0) {
		const nextPool = {
			active: pool.active.slice(result.consumed.active),
			idleManual: pool.idleManual.slice(result.consumed.idleManual),
			halted: pool.halted.slice(result.consumed.halted),
			doneCanceled: pool.doneCanceled.slice(result.consumed.doneCanceled),
		};
		const nextResult = fillOnePage({ pools: nextPool, cols: input.cols, rows: input.rows });
		if (nextResult.sections.length === 0) break;
		pool = nextPool;
		page += 1;
		result = nextResult;
		lastNonEmpty = result;
	}
	// If the caller requested a page past the last drawable page, clamp the
	// returned `page` to the last filled page (the existing flat-paging
	// contract) — never an empty rendering of a higher page.
	if (page < input.page) {
		// stayed on the last non-empty page; expose that page index, not the request.
	}
	result = lastNonEmpty;
	// pageCount: simulate forward from the original groups until pool is drained.
	let pageCount = totalRuns === 0 ? 0 : 1;
	{
		let p: Record<WallGroupKey, CollabSummary[]> = {
			active: [...input.groups.active],
			idleManual: [...input.groups.idleManual],
			halted: [...input.groups.halted],
			doneCanceled: [...input.groups.doneCanceled],
		};
		let remaining =
			p.active.length + p.idleManual.length + p.halted.length + p.doneCanceled.length;
		while (remaining > 0) {
			const r = fillOnePage({ pools: p, cols: input.cols, rows: input.rows });
			const taken =
				r.consumed.active + r.consumed.idleManual + r.consumed.halted + r.consumed.doneCanceled;
			if (taken === 0) break; // guard against infinite loop on impossibly small terminals.
			p = {
				active: p.active.slice(r.consumed.active),
				idleManual: p.idleManual.slice(r.consumed.idleManual),
				halted: p.halted.slice(r.consumed.halted),
				doneCanceled: p.doneCanceled.slice(r.consumed.doneCanceled),
			};
			remaining -= taken;
			if (remaining > 0) pageCount += 1;
		}
	}
	return { sections: result.sections, page, pageCount, totalRuns };
}

function attentionRank(s: CollabSummary): number {
	if (
		s.chainStatus === "escalated" ||
		s.chainStatus === "abandoned" ||
		s.workflowStatus === "halted" ||
		s.workflowStatus === "canceled"
	)
		return 0; // stuck
	if (s.workflowStatus === "running") return 1; // active
	if (s.workflowStatus === "done") return 3; // done
	return 2; // idle (incl. manual relay)
}

// `CollabSummary.lastActivityAt` is "" for a running workflow with no
// handoffs yet (Task-1 contract: that's the MOST recent activity). Map ""
// to a max sentinel so the desc tiebreak sorts it FIRST within its rank,
// not lexicographic-last.
function actKey(s: CollabSummary): string {
	return s.lastActivityAt === "" ? "￿" : s.lastActivityAt;
}

// Pure sort + paginate, NO projection (no snapshots needed). The host calls
// this FIRST so it fetches per-collab snapshots ONLY for the visible page —
// spec §4 bounded cost: an off-screen collab costs just its summary row.
// buildWallState reuses it so the ordering is single-sourced.
export function selectWallPage(input: {
	summaries: CollabSummary[];
	capacity: number;
	page: number;
	selected: number;
}): {
	pageSummaries: CollabSummary[];
	page: number;
	pageCount: number;
	totalRuns: number;
	selected: number;
} {
	const cap = Math.max(1, Math.floor(input.capacity));
	const sorted = [...input.summaries].sort((a, b) => {
		const r = attentionRank(a) - attentionRank(b);
		if (r !== 0) return r;
		const ka = actKey(a);
		const kb = actKey(b);
		return ka < kb ? 1 : ka > kb ? -1 : 0;
	});
	const totalRuns = sorted.length;
	const pageCount = Math.ceil(totalRuns / cap);
	const page =
		totalRuns === 0 ? 0 : Math.min(Math.max(0, input.page), pageCount - 1);
	const pageSummaries = sorted.slice(page * cap, page * cap + cap);
	const selected =
		pageSummaries.length === 0
			? 0
			: Math.min(Math.max(0, input.selected), pageSummaries.length - 1);
	return { pageSummaries, page, pageCount, totalRuns, selected };
}

function maxIso(rows: RunCostRow[]): string | null {
	let m: string | null = null;
	for (const r of rows) {
		const t = r.resolvedAt ?? r.lastActivityAt;
		if (m === null || t > m) m = t;
	}
	return m;
}
function minIso(rows: RunCostRow[]): string | null {
	let m: string | null = null;
	for (const r of rows) if (m === null || r.createdAt < m) m = r.createdAt;
	return m;
}

export function buildInspectorState(input: {
	snapshot: RelayViewSnapshot;
	phaseRuns: PhaseRunRef[];
	phaseMaxRounds: Record<number, number>;
	costRows: RunCostRow[];
	workflowCreatedAt: string | null;
	chainId: string | null;
	evidenceHandoffs: RelayHandoffLogRow[];
	evaluatorDiags: Array<{ verdict: string | null; confidence: number | null; reason: string | null; outcome: string }>;
	captureDiags: Array<{ captureStatus: string; turnConfidence: string }>;
	focusedPhaseRunId: string | null;
	// Bug B (optional, additive): the collab's full workflow run history and
	// which workflow is currently selected/inspected. Absent → empty history.
	workflows?: WorkflowSummaryRow[];
	selectedWorkflowId?: string | null;
}): InspectorState {
	const live = buildRelayViewState(input.snapshot);

	const inByPhase = new Map<string | null, number>();
	const outByPhase = new Map<string | null, number>();
	let totalIn = 0;
	let totalOut = 0;
	for (const r of input.costRows) {
		inByPhase.set(r.phaseRunId, (inByPhase.get(r.phaseRunId) ?? 0) + r.inChars);
		outByPhase.set(r.phaseRunId, (outByPhase.get(r.phaseRunId) ?? 0) + r.outChars);
		totalIn += r.inChars;
		totalOut += r.outChars;
	}

	const roundsByPhase = new Map<string, number>();
	for (const h of input.snapshot.handoffs) {
		if (h.phaseRunId && h.roundNumber != null) {
			roundsByPhase.set(
				h.phaseRunId,
				Math.max(roundsByPhase.get(h.phaseRunId) ?? 0, h.roundNumber),
			);
		}
	}

	const timeline: PhaseStat[] = input.phaseRuns
		.slice()
		.sort((a, b) => a.phaseIndex - b.phaseIndex)
		.map((p) => ({
			phaseRunId: p.phaseRunId,
			phaseIndex: p.phaseIndex,
			phaseName: p.phaseName,
			roundsUsed: roundsByPhase.get(p.phaseRunId) ?? 0,
			maxRounds: input.phaseMaxRounds[p.phaseIndex] ?? 0,
			durationMs:
				p.endedAt != null ? Date.parse(p.endedAt) - Date.parse(p.startedAt) : null,
			outcome: p.outcome,
			estInTokens: estimateTokens(inByPhase.get(p.phaseRunId) ?? 0),
			estOutTokens: estimateTokens(outByPhase.get(p.phaseRunId) ?? 0),
		}));

	const phaseName = new Map(input.phaseRuns.map((p) => [p.phaseRunId, p.phaseName]));
	const perPhaseKeys: Array<string | null> = [];
	for (const r of input.costRows) if (!perPhaseKeys.includes(r.phaseRunId)) perPhaseKeys.push(r.phaseRunId);
	const durByPhase = new Map(
		input.phaseRuns.map((p) => [
			p.phaseRunId,
			p.endedAt != null ? Date.parse(p.endedAt) - Date.parse(p.startedAt) : null,
		]),
	);
	const cost: CostSummary = {
		totalMs: (() => {
			if (input.costRows.length === 0) return 0;
			const end = maxIso(input.costRows);
			const base = input.workflowCreatedAt ?? minIso(input.costRows);
			if (!end || !base) return 0;
			return Math.max(0, Date.parse(end) - Date.parse(base));
		})(),
		estInputTokens: estimateTokens(totalIn),
		estOutputTokens: estimateTokens(totalOut),
		perPhase: perPhaseKeys.map((k) => ({
			phaseRunId: k,
			phaseName: k ? (phaseName.get(k) ?? k) : "manual relay",
			estInTokens: estimateTokens(inByPhase.get(k) ?? 0),
			estOutTokens: estimateTokens(outByPhase.get(k) ?? 0),
			durationMs: k ? (durByPhase.get(k) ?? null) : null,
		})),
	};

	const excerpt = (s: string | null): string => {
		const t = (s ?? "").replace(/\s+/g, " ").trim();
		return t.length > 80 ? `${t.slice(0, 80)}…` : t;
	};
	const items: EvidenceItem[] = input.evidenceHandoffs.map((h) => ({
		round: h.roundNumber,
		step: h.handoffStep,
		sender: h.senderAgent,
		target: h.targetAgent,
		verdict: h.evaluatorVerdict,
		confidence: h.evaluatorConfidence,
		reasonExcerpt: excerpt(h.evaluatorReason),
		captureStatus: h.captureStatus,
	}));
	const diagnostics: DiagItem[] = [
		...input.evaluatorDiags.map((d) => ({
			kind: "evaluator" as const,
			text: `verdict ${d.verdict ?? "-"} conf ${d.confidence ?? "-"} · ${d.outcome} · ${excerpt(d.reason).slice(0, 60)}`,
		})),
		...input.captureDiags.map((d) => ({
			kind: "capture" as const,
			text: `capture ${d.captureStatus} · turn ${d.turnConfidence}`,
		})),
	];
	const confs = input.evaluatorDiags
		.map((d) => d.confidence)
		.filter((c): c is number => typeof c === "number");
	const declining = confs.length >= 2 && confs[confs.length - 1]! < confs[0]!;
	const captureBad = input.captureDiags.some((d) => d.captureStatus !== "ok");
	const rounds = input.snapshot.chain?.currentRound ?? 0;
	const maxR = input.snapshot.chain?.maxRounds ?? 0;
	let likelyCause: string;
	if (
		live.stuck &&
		(input.snapshot.chain?.status === "escalated" ||
			(maxR > 1 && rounds >= maxR)) &&
		declining
	) {
		likelyCause = `${rounds}/${maxR} rounds, verdict never reached approve, confidence declining → likely under-specified input or maxRounds too low`;
	} else if (captureBad) {
		likelyCause = `capture issues (${input.captureDiags.filter((d) => d.captureStatus !== "ok").length}) — provider output may be truncated/low-confidence`;
	} else if (live.stuck) {
		likelyCause = `stuck: ${live.why ?? "see status"}`;
	} else {
		likelyCause = "no blocking signal — run progressing";
	}
	const evidence = {
		phase:
			input.phaseRuns.find((p) => p.phaseRunId === input.focusedPhaseRunId)
				?.phaseName ?? null,
		chainId: input.chainId,
		items,
		diagnostics,
		likelyCause,
	};

	const workflowHistory: WorkflowHistoryItem[] = (input.workflows ?? []).map((w) => ({
		workflowId: w.workflowId,
		workflowType: w.workflowType,
		name: w.name,
		status: w.status,
		currentPhaseIndex: w.currentPhaseIndex,
		createdAt: w.createdAt,
		selected: input.selectedWorkflowId != null && w.workflowId === input.selectedWorkflowId,
	}));

	return { live, timeline, evidence, cost, workflowHistory };
}

// deriveLogLines emits: "HH:MM:SS  P·R   sender→target  step   verdict   preview"
// We want step / route / verdict only.
function parseEventText(text: string): WallEvent {
	const cols = text.split(/\s{2,}/);
	const route = cols.find((c) => /[a-z]+→[a-z]+/i.test(c)) ?? "";
	const tokens = cols.filter((c) => c !== route);
	// tokens[0] = time, tokens[1] = P·R (when workflow), tokens[2] = step, tokens[3] = verdict
	const step = tokens[2] ?? "";
	const verdict = tokens[3] ?? "-";
	return { step, route, verdict };
}

function projectPane(
	s: CollabSummary,
	now: string,
	idleThresholdMs: number,
	snap: { handoffs: RelayHandoffLogRow[]; phaseRuns: PhaseRunRef[]; totalPhases: number },
	home: string,
): WallPaneState {
	// Bug C / Task 8b: feed the active step into the liveness snapshot so the
	// phase-aware budget (execute/review → larger) applies on the Wall too.
	let wallStep: string | null = null;
	if (s.currentPhaseRunId) {
		for (let i = snap.handoffs.length - 1; i >= 0; i--) {
			if (snap.handoffs[i]!.phaseRunId === s.currentPhaseRunId) {
				wallStep = snap.handoffs[i]!.handoffStep;
				break;
			}
		}
	}
	const rv = buildRelayViewState({
		now,
		idleThresholdMs,
		workflow:
			s.workflowId && s.workflowType
				? {
						workflowId: s.workflowId,
						workflowType: s.workflowType,
						name: s.label,
						status: s.workflowStatus ?? "running",
						createdAt: s.workflowCreatedAt ?? now,
						haltReason: null,
					}
				: null,
		phaseRuns: snap.phaseRuns,
		currentPhaseRunId: s.currentPhaseRunId,
		currentStep: wallStep, // budget input only; the pane still renders P/R
		totalPhases: snap.totalPhases,
		chain:
			s.currentRound != null && s.maxRounds != null && s.chainStatus
				? { currentRound: s.currentRound, maxRounds: s.maxRounds, status: s.chainStatus }
				: null,
		turn: {
			turnOwner: s.turn.owner,
			waitingAgent: s.turn.waiting,
			handoffState: s.turn.handoffState,
		},
		sessions: s.sessions,
		lastActivityAt: s.lastActivityAt,
		handoffs: snap.handoffs,
	});
	const glyph = statusGlyph({
		workflowStatus: s.workflowStatus,
		stuck: rv.stuck,
	});
	const round =
		s.currentRound != null && s.maxRounds != null
			? { current: s.currentRound, max: s.maxRounds }
			: null;
	const progress =
		s.phaseIndex != null && snap.totalPhases > 0
			? { current: s.phaseIndex + 1, total: snap.totalPhases }
			: null;
	const events = rv.logLines
		.filter((l) => l.kind === "event")
		.slice(-2)
		.reverse() // newest first
		.map((l) => parseEventText(l.text));
	const cardKind: "full" | "compact" = glyph.key === "running" ? "full" : "compact";
	const baseMs = s.workflowCreatedAt != null ? Date.parse(s.workflowCreatedAt) : NaN;
	// Freeze elapsed at the actual run duration once a workflow is terminal —
	// done/canceled/halted clocks keep ticking otherwise (just noise on a card
	// that will never advance again). Use the latest handoff time as the
	// run's effective end; fall back to `now` only while still running.
	const isTerminal =
		s.workflowStatus === "done" ||
		s.workflowStatus === "halted" ||
		s.workflowStatus === "canceled";
	const endIso = isTerminal && s.lastActivityAt ? s.lastActivityAt : now;
	const endMs = Date.parse(endIso);
	const elapsed =
		Number.isFinite(endMs) && Number.isFinite(baseMs)
			? fmtDur(Math.max(0, endMs - baseMs))
			: "—";

	return {
		collabId: s.collabId,
		workflowId: s.workflowId,
		statusKey: glyph.key,
		label: s.label,
		workflowType: s.workflowType,
		round,
		progress,
		agentHealth: rv.agentHealth,
		stuckWhy: rv.stuck ? rv.why : null,
		events,
		elapsed,
		startIso: s.workflowCreatedAt,
		artifact: s.specPath,
		cwd: s.workspaceRoot ? abbreviateCwd(s.workspaceRoot, home) : null,
		cardKind,
	};
}

export function buildWallState(input: {
	summaries: CollabSummary[];
	now: string;
	idleThresholdMs: number;
	// `capacity` is retained for back-compat. When set and no `cols`/`rows` are
	// supplied, a synthetic geometry (1 col × capacity × full-card height + 1
	// section header) is used so a single ACTIVE section emerges with capacity
	// cards — matching the old flat behaviour for legacy callers.
	capacity?: number;
	cols?: number;
	rows?: number;
	page: number;
	selected: number;
	snapshots: Record<
		string,
		{ handoffs: RelayHandoffLogRow[]; phaseRuns: PhaseRunRef[]; totalPhases: number }
	>;
	home?: string;
}): WallState {
	const home = input.home ?? homedir();
	const groups = partitionWallGroups(input.summaries);
	let cols: number;
	let rows: number;
	if (input.cols != null && input.rows != null) {
		cols = input.cols;
		rows = input.rows;
	} else {
		const cap = Math.max(1, Math.floor(input.capacity ?? 1));
		// synthetic geometry: 1 col × enough rows for `cap` full cards + header
		cols = MIN_PANE_COLS;
		rows = HEADER_ROWS + cap * CARD_HEIGHT.full;
	}
	const alloc = allocateWallSections({ groups, cols, rows, page: input.page });
	const sections: WallStateSection[] = alloc.sections.map((sec) => ({
		group: sec.group,
		label: sec.label,
		cardKind: sec.cardKind,
		panes: sec.cards.map((sum) => {
			const snap =
				input.snapshots[runKey(sum)] ??
				input.snapshots[sum.collabId] ?? {
					handoffs: [],
					phaseRuns: [],
					totalPhases: 0,
				};
			return projectPane(sum, input.now, input.idleThresholdMs, snap, home);
		}),
	}));
	const panes = sections.flatMap((sec) => sec.panes);
	const selected = Math.min(Math.max(0, input.selected), Math.max(0, panes.length - 1));
	return {
		sections,
		panes,
		page: alloc.page,
		pageCount: alloc.pageCount,
		totalRuns: alloc.totalRuns,
		selected,
	};
}
