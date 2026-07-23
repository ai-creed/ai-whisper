import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";
import { displayArtifactPath } from "@ai-whisper/shared";
import { basename } from "node:path";

export type CollabSummary = {
	collabId: string;
	label: string;
	workspaceRoot: string;
	workflowId: string | null;
	workflowType: string | null;
	workflowStatus: "running" | "paused" | "done" | "halted" | "canceled" | null;
	currentPhaseRunId: string | null;
	phaseIndex: number | null;
	phaseName: string | null;
	currentRound: number | null;
	maxRounds: number | null;
	chainStatus: "active" | "done" | "escalated" | "abandoned" | null;
	turn: {
		owner: AgentType | "none";
		waiting: AgentType | null;
		handoffState: string;
	};
	// Per-agent liveness (Bug C): `mountAlive` is filled in by the dashboard
	// host's pid probe, not by this repo query (it stays absent here). Threaded
	// so the Wall path can feed it into computeLiveness.
	sessions: Array<{ agentType: string; healthState: string; mountAlive?: boolean }>;
	workflowCreatedAt: string | null; // additive — see spec Non-Goals
	specPath: string | null; // additive — repo-relative artifact path (Fix 3)
	lastActivityAt: string;
	// additive — true when the OWNING COLLAB is archived (collab.archived_at
	// IS NOT NULL). Always false on the Wall path (listActiveCollabSummaries
	// excludes archived collabs outright); only listAllWorkflowSummaries's
	// run-ledger view can surface true. Optional so pre-existing CollabSummary
	// object literals (e.g. test fixtures) don't need updating.
	archived?: boolean;
};

export type WorkflowSummaryRow = {
	workflowId: string;
	workflowType: string;
	name: string | null;
	status: "running" | "paused" | "done" | "halted" | "canceled";
	currentPhaseIndex: number;
	createdAt: string;
};

export type RunCostRow = {
	phaseRunId: string | null;
	createdAt: string;
	resolvedAt: string | null;
	lastActivityAt: string;
	inChars: number;
	outChars: number;
};

// Eligible = a workflow is in-flight (`running` or `paused`), OR the collab had
// relay activity within the recency window. `paused` is window-independent like
// `running` (spec paused carve-out): an operator-suspended run is current and
// resumable, so a collab whose latest workflow is paused surfaces in the default
// Wall (grouped ACTIVE) instead of vanishing when it has no recent handoffs.
// Resolution mirrors the #1 host: running workflow (unique per the schema index)
// → else most-recent workflow → else manual-relay (null). All reads are CURRENT
// rows (no cursor) so in-place mutations are reflected.
//
// `minResults` (default 3): a finished run drops off the wall once its activity
// ages past the window. To keep recent runs visible, when fewer than
// `minResults` collabs are eligible we backfill with the most-recently-created
// FINISHED-workflow collabs (done/halted/canceled), newest-first, deduped.
export function listActiveCollabSummaries(
	db: Database.Database,
	input: { sinceMs: number; now?: string; minResults?: number },
): CollabSummary[] {
	const nowMs = Date.parse(input.now ?? new Date().toISOString());
	const base = Number.isFinite(nowMs) ? nowMs : Date.now();
	// `--window all` (and other very large sinceMs values) would underflow
	// `base - sinceMs` below epoch, and `new Date(negative).toISOString()`
	// throws RangeError. Clamp to 0 so the cutoff becomes 1970-01-01 — every
	// real `last_activity_at` is lexicographically ≥ that, so the eligibility
	// filter degenerates to "any collab with activity ever", which is what
	// the operator asked for.
	const cutoff = new Date(Math.max(0, base - input.sinceMs)).toISOString();

	const eligible = db
		.prepare(
			`SELECT c.collab_id AS collabId,
			        COALESCE(MAX(h.last_activity_at), '') AS lastAct
			   FROM collab c
			   LEFT JOIN relay_handoff h ON h.collab_id = c.collab_id
			  WHERE c.archived_at IS NULL
			  GROUP BY c.collab_id
			 HAVING MAX(h.last_activity_at) >= ?
			     OR EXISTS (SELECT 1 FROM workflows w
			                 WHERE w.collab_id = c.collab_id
			                   AND (w.status IN ('running','paused') OR w.created_at >= ?))`,
		)
		.all(cutoff, cutoff) as Array<{ collabId: string; lastAct: string }>;

	const out: CollabSummary[] = [];
	const seen = new Set<string>();
	for (const e of eligible) {
		out.push(buildCollabSummary(db, e.collabId));
		seen.add(e.collabId);
	}

	// Backfill to the floor with the newest finished-workflow collabs not already
	// shown. Ordered by each collab's most-recent finished workflow, newest first.
	const minResults = input.minResults ?? 3;
	if (out.length < minResults) {
		const finished = db
			.prepare(
				`SELECT w.collab_id AS collabId, MAX(w.created_at) AS lastCreated
				   FROM workflows w
				   JOIN collab c ON c.collab_id = w.collab_id
				  WHERE w.status IN ('done','halted','canceled')
				    AND c.archived_at IS NULL
				  GROUP BY w.collab_id
				  ORDER BY lastCreated DESC, w.collab_id DESC`,
			)
			.all() as Array<{ collabId: string; lastCreated: string }>;
		for (const f of finished) {
			if (out.length >= minResults) break;
			if (seen.has(f.collabId)) continue;
			out.push(buildCollabSummary(db, f.collabId));
			seen.add(f.collabId);
		}
	}
	return out;
}

// One workflow row as projected onto a Wall card. Shared by the collab-latest
// path (buildCollabSummary) and the per-run path (listAllWorkflowSummaries).
type WorkflowProjectionRow = {
	workflowId: string;
	workflowType: string;
	name: string | null;
	status: "running" | "paused" | "done" | "halted" | "canceled";
	currentPhaseIndex: number;
	createdAt: string;
	specPath: string;
	// Owning-collab archived flag (Task 6). Only listAllWorkflowSummaries's SQL
	// populates this (JOIN collab ... c.archived_at); the wall's buildCollabSummary
	// path never sets it — those collabs are already excluded from eligibility.
	archived?: boolean;
};

// Project ONE run (or the manual-relay slice when `wf` is null) of a collab into
// a CollabSummary. Per-collab facts (label, turn, sessions) are shared; per-run
// facts (phase, chain, run-scoped last activity) come from `wf`.
function buildWorkflowSummary(
	db: Database.Database,
	collabId: string,
	wf: WorkflowProjectionRow | null,
): CollabSummary {
	const collab = db
		.prepare(
			`SELECT display_name AS displayName, workspace_root AS workspaceRoot
			   FROM collab WHERE collab_id = ?`,
		)
		.get(collabId) as { displayName: string; workspaceRoot: string } | undefined;

	let currentPhaseRunId: string | null = null;
	let phaseIndex: number | null = null;
	let phaseName: string | null = null;
	let chainId: string | null = null;
	if (wf) {
		const ph = db
			.prepare(
				`SELECT phase_run_id AS phaseRunId, phase_index AS phaseIndex,
				        phase_name AS phaseName, chain_id AS chainId
				   FROM workflow_phases WHERE workflow_id = ?
				  ORDER BY (ended_at IS NULL) DESC, started_at DESC
				  LIMIT 1`,
			)
			.get(wf.workflowId) as
			| { phaseRunId: string; phaseIndex: number; phaseName: string; chainId: string }
			| undefined;
		if (ph) {
			currentPhaseRunId = ph.phaseRunId;
			phaseIndex = ph.phaseIndex;
			phaseName = ph.phaseName;
			chainId = ph.chainId;
		}
	}

	const chain = chainId
		? (db
				.prepare(
					`SELECT status, current_round AS currentRound, max_rounds AS maxRounds
					   FROM relay_chains WHERE chain_id = ?`,
				)
				.get(chainId) as
				| {
						status: "active" | "done" | "escalated" | "abandoned";
						currentRound: number;
						maxRounds: number;
					}
				| undefined)
		: undefined;

	const turn = db
		.prepare(
			`SELECT turn_owner AS owner, waiting_agent AS waiting, handoff_state AS handoffState
			   FROM relay_turn_state WHERE collab_id = ?`,
		)
		.get(collabId) as
		| { owner: AgentType | "none"; waiting: AgentType | null; handoffState: string }
		| undefined;

	const sessions = db
		.prepare(
			`SELECT agentType, healthState FROM (
			   SELECT s.agent_type AS agentType,
			          s.health_state AS healthState,
			          ROW_NUMBER() OVER (
			            PARTITION BY s.agent_type
			            ORDER BY CASE WHEN sb.active_session_id = s.session_id
			                          THEN 0 ELSE 1 END ASC,
			                     s.registered_at DESC,
			                     s.rowid DESC
			          ) AS rn
			     FROM session s
			     LEFT JOIN session_binding sb
			       ON sb.collab_id = s.collab_id
			      AND sb.agent_type = s.agent_type
			    WHERE s.collab_id = ?
			 ) ranked
			 WHERE rn = 1
			 ORDER BY agentType ASC`,
		)
		.all(collabId) as Array<{ agentType: string; healthState: string }>;

	const label =
		(wf?.name && wf.name.trim()) ||
		(collab?.displayName && collab.displayName.trim()) ||
		(collab?.workspaceRoot ? basename(collab.workspaceRoot) : "") ||
		collabId.slice(0, 12);

	// Scope `lastActivityAt` to THIS run so liveness/stuck and the sort tie-break
	// reflect the run's own activity, not a collab-wide MAX.
	const runLastActRow = wf
		? (db
				.prepare(
					`SELECT COALESCE(MAX(last_activity_at), '') AS lastAct
					   FROM relay_handoff
					  WHERE collab_id = ? AND workflow_id = ?`,
				)
				.get(collabId, wf.workflowId) as { lastAct: string } | undefined)
		: (db
				.prepare(
					`SELECT COALESCE(MAX(last_activity_at), '') AS lastAct
					   FROM relay_handoff
					  WHERE collab_id = ? AND workflow_id IS NULL`,
				)
				.get(collabId) as { lastAct: string } | undefined);
	const runLastAct = runLastActRow?.lastAct ?? "";

	return {
		collabId,
		label,
		workspaceRoot: collab?.workspaceRoot ?? "",
		workflowId: wf?.workflowId ?? null,
		workflowType: wf?.workflowType ?? null,
		workflowStatus: wf?.status ?? null,
		currentPhaseRunId,
		phaseIndex,
		phaseName,
		currentRound: chain?.currentRound ?? null,
		maxRounds: chain?.maxRounds ?? null,
		chainStatus: chain?.status ?? null,
		turn: {
			owner: turn?.owner ?? "none",
			waiting: turn?.waiting ?? null,
			handoffState: turn?.handoffState ?? "idle",
		},
		sessions,
		workflowCreatedAt: wf?.createdAt ?? null,
		specPath: wf ? displayArtifactPath(wf.specPath, collab?.workspaceRoot ?? "") : null,
		lastActivityAt: runLastAct,
		archived: wf?.archived ?? false,
	};
}

// Project a single collab into a CollabSummary using its running-or-latest
// workflow (LIMIT 1) — the default Wall's one-card-per-collab resolution.
function buildCollabSummary(db: Database.Database, collabId: string): CollabSummary {
	const wf = db
		.prepare(
			`SELECT workflow_id AS workflowId, workflow_type AS workflowType,
			        name, status, current_phase_index AS currentPhaseIndex,
			        created_at AS createdAt, spec_path AS specPath
			   FROM workflows WHERE collab_id = ?
			  ORDER BY (status = 'running') DESC, created_at DESC
			  LIMIT 1`,
		)
		.get(collabId) as WorkflowProjectionRow | undefined;
	return buildWorkflowSummary(db, collabId, wf ?? null);
}

// One CollabSummary per WORKFLOW RUN — no per-collab masking — for the
// dashboard `--all` mode. Run-level eligibility (mirrors the `cutoff` math in
// listActiveCollabSummaries): a run shows if it is non-terminal (running or
// paused — always current), OR its own latest handoff activity is within the
// window, OR (no handoffs) it was created within the window. Manual relays are
// excluded (workflows only). Newest-created first.
export function listAllWorkflowSummaries(
	db: Database.Database,
	input: { sinceMs: number; now?: string },
): CollabSummary[] {
	const nowMs = Date.parse(input.now ?? new Date().toISOString());
	const base = Number.isFinite(nowMs) ? nowMs : Date.now();
	const cutoff = new Date(Math.max(0, base - input.sinceMs)).toISOString();

	const rows = db
		.prepare(
			`SELECT w.workflow_id AS workflowId, w.workflow_type AS workflowType,
			        w.name AS name, w.status AS status,
			        w.current_phase_index AS currentPhaseIndex,
			        w.created_at AS createdAt, w.spec_path AS specPath,
			        w.collab_id AS collabId,
			        c.archived_at IS NOT NULL AS archived
			   FROM workflows w
			   JOIN collab c ON c.collab_id = w.collab_id
			   LEFT JOIN relay_handoff h ON h.workflow_id = w.workflow_id
			  GROUP BY w.workflow_id
			 HAVING w.status IN ('running','paused')
			     OR MAX(h.last_activity_at) >= ?
			     OR (MAX(h.last_activity_at) IS NULL AND w.created_at >= ?)
			  ORDER BY w.created_at DESC, w.rowid DESC`,
		)
		.all(cutoff, cutoff) as Array<
		Omit<WorkflowProjectionRow, "archived"> & { collabId: string; archived: number }
	>;

	return rows.map((r) =>
		buildWorkflowSummary(db, r.collabId, { ...r, archived: Boolean(r.archived) }),
	);
}

// Bug B: enumerate the FULL workflow run history for a collab, newest-first.
// The Wall summary lookup (above) intentionally stays `LIMIT 1` (active/latest);
// this separate query feeds the Inspector workflow-history list. Purely
// additive — no schema change.
export function listWorkflowsForCollab(
	db: Database.Database,
	collabId: string,
): WorkflowSummaryRow[] {
	const rows = db
		.prepare(
			`SELECT workflow_id AS workflowId, workflow_type AS workflowType,
			        name, status, current_phase_index AS currentPhaseIndex,
			        created_at AS createdAt
			   FROM workflows WHERE collab_id = ?
			  ORDER BY created_at DESC, rowid DESC`,
		)
		.all(collabId) as Array<{
		workflowId: string;
		workflowType: string;
		name: string | null;
		status: "running" | "paused" | "done" | "halted" | "canceled";
		currentPhaseIndex: number;
		createdAt: string;
	}>;
	return rows.map((r) => ({
		workflowId: r.workflowId,
		workflowType: r.workflowType,
		name: r.name,
		status: r.status,
		currentPhaseIndex: r.currentPhaseIndex,
		createdAt: r.createdAt,
	}));
}

// Inspector "Cost" detail. Returns CHARACTER COUNTS + timestamps only —
// never raw request/handback text (privacy + perf: the wall path must not
// pull large text every poll). workflowId null → manual-relay run scope.
export function listRunCostRows(
	db: Database.Database,
	input: { collabId: string; workflowId: string | null },
): RunCostRow[] {
	const sql =
		`SELECT phase_run_id AS phaseRunId, created_at AS createdAt,
		        resolved_at AS resolvedAt, last_activity_at AS lastActivityAt,
		        (LENGTH(COALESCE(request_text,'')) + LENGTH(COALESCE(root_request_text,''))) AS inChars,
		        LENGTH(COALESCE(handback_text,'')) AS outChars
		   FROM relay_handoff
		  WHERE collab_id = ? AND ` +
		(input.workflowId === null ? "workflow_id IS NULL" : "workflow_id = ?") +
		" ORDER BY created_at ASC, handoff_id ASC";
	const stmt = db.prepare(sql);
	const rows = (
		input.workflowId === null
			? stmt.all(input.collabId)
			: stmt.all(input.collabId, input.workflowId)
	) as Array<{
		phaseRunId: string | null;
		createdAt: string;
		resolvedAt: string | null;
		lastActivityAt: string;
		inChars: number;
		outChars: number;
	}>;
	return rows.map((r) => ({
		phaseRunId: r.phaseRunId,
		createdAt: r.createdAt,
		resolvedAt: r.resolvedAt,
		lastActivityAt: r.lastActivityAt,
		inChars: r.inChars,
		outChars: r.outChars,
	}));
}
