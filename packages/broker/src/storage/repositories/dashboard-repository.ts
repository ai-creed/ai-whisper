import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";
import { basename } from "node:path";

export type CollabSummary = {
	collabId: string;
	label: string;
	workflowId: string | null;
	workflowType: string | null;
	workflowStatus: "running" | "done" | "halted" | "canceled" | null;
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
	lastActivityAt: string;
};

export type WorkflowSummaryRow = {
	workflowId: string;
	workflowType: string;
	name: string | null;
	status: "running" | "done" | "halted" | "canceled";
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

// Eligible = a workflow is `running`, OR the collab had relay activity within
// the recency window. Resolution mirrors the #1 host: running workflow (unique
// per the schema index) → else most-recent workflow → else manual-relay (null).
// All reads are CURRENT rows (no cursor) so in-place mutations are reflected.
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
			  GROUP BY c.collab_id
			 HAVING MAX(h.last_activity_at) >= ?
			     OR EXISTS (SELECT 1 FROM workflows w
			                 WHERE w.collab_id = c.collab_id AND w.status = 'running')`,
		)
		.all(cutoff) as Array<{ collabId: string; lastAct: string }>;

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
				`SELECT collab_id AS collabId, MAX(created_at) AS lastCreated
				   FROM workflows
				  WHERE status IN ('done','halted','canceled')
				  GROUP BY collab_id
				  ORDER BY lastCreated DESC, collab_id DESC`,
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

// Project a single collab into a CollabSummary. Resolution: running workflow →
// else most-recent workflow → else manual-relay (null). Shared by the eligible
// and backfill paths so both build identical rows.
function buildCollabSummary(db: Database.Database, collabId: string): CollabSummary {
	{
		const e = { collabId };
		const collab = db
			.prepare(
				`SELECT display_name AS displayName, workspace_root AS workspaceRoot
				   FROM collab WHERE collab_id = ?`,
			)
			.get(e.collabId) as { displayName: string; workspaceRoot: string } | undefined;

		const wf = db
			.prepare(
				`SELECT workflow_id AS workflowId, workflow_type AS workflowType,
				        name, status, current_phase_index AS currentPhaseIndex,
				        created_at AS createdAt
				   FROM workflows WHERE collab_id = ?
				  ORDER BY (status = 'running') DESC, created_at DESC
				  LIMIT 1`,
			)
			.get(e.collabId) as
			| {
					workflowId: string;
					workflowType: string;
					name: string | null;
					status: "running" | "done" | "halted" | "canceled";
					currentPhaseIndex: number;
					createdAt: string;
				}
			| undefined;

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
			.get(e.collabId) as
			| { owner: AgentType | "none"; waiting: AgentType | null; handoffState: string }
			| undefined;

		// Return ONE row per agent_type: prefer the session that is the agent's
		// bound active_session_id; otherwise fall back to the row with the
		// greatest registered_at. This stops a stale prior-mount (degraded) row
		// from masking a freshly re-mounted, healthy bound session (Bug A). The
		// chosen row's health is preserved as-is (degraded is NOT coerced).
		// The ranking key sorts the bound row first (is_bound DESC), then by
		// registered_at DESC, then rowid DESC as a deterministic tiebreak; row 1
		// per agent_type is the pick.
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
			.all(e.collabId) as Array<{ agentType: string; healthState: string }>;

		const label =
			(wf?.name && wf.name.trim()) ||
			(collab?.displayName && collab.displayName.trim()) ||
			(collab?.workspaceRoot ? basename(collab.workspaceRoot) : "") ||
			e.collabId.slice(0, 12);

		// Scope `lastActivityAt` to the RESOLVED run so it drives Wall
		// liveness/stuck and the sort tie-break (`actKey`) by THIS run's
		// activity, not a collab-wide MAX. Sibling-run handoffs on the
		// same collab must not bump a stale pane back to fresh.
		const runLastActRow = wf
			? (db
					.prepare(
						`SELECT COALESCE(MAX(last_activity_at), '') AS lastAct
						   FROM relay_handoff
						  WHERE collab_id = ? AND workflow_id = ?`,
					)
					.get(e.collabId, wf.workflowId) as { lastAct: string } | undefined)
			: (db
					.prepare(
						`SELECT COALESCE(MAX(last_activity_at), '') AS lastAct
						   FROM relay_handoff
						  WHERE collab_id = ? AND workflow_id IS NULL`,
					)
					.get(e.collabId) as { lastAct: string } | undefined);
		const runLastAct = runLastActRow?.lastAct ?? "";

		return {
			collabId: e.collabId,
			label,
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
			lastActivityAt: runLastAct,
		};
	}
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
		status: "running" | "done" | "halted" | "canceled";
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
