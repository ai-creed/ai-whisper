import Database from "better-sqlite3";
import { join } from "node:path";
import { ZERO_USAGE, addUsage, type UsageTotals } from "../types.ts";

function open(stateRoot: string): Database.Database {
	const db = new Database(join(stateRoot, "state.db"), { readonly: true, fileMustExist: true });
	db.pragma("busy_timeout = 2000");
	return db;
}

function withDb<T>(stateRoot: string, fn: (db: Database.Database) => T): T {
	const db = open(stateRoot);
	try { return fn(db); } finally { db.close(); }
}

export function readBoundAgents(stateRoot: string, collabId: string): string[] {
	return withDb(stateRoot, (db) =>
		(db.prepare("SELECT agent_type FROM session_binding WHERE collab_id = ? AND binding_state = 'bound' ORDER BY agent_type").all(collabId) as Array<{ agent_type: string }>).map((r) => r.agent_type),
	);
}

export function readCollabForWorkspace(stateRoot: string, workspaceRoot: string): { collabId: string; status: string } | null {
	return withDb(stateRoot, (db) => {
		const row = db.prepare("SELECT collab_id, status FROM collab WHERE workspace_root = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1").get(workspaceRoot) as { collab_id: string; status: string } | undefined;
		return row ? { collabId: row.collab_id, status: row.status } : null;
	});
}

export function readWorkflow(stateRoot: string, workflowId: string): { status: string; haltReason: string | null; currentPhaseIndex: number } | null {
	return withDb(stateRoot, (db) => {
		const row = db.prepare("SELECT status, halt_reason, current_phase_index FROM workflows WHERE workflow_id = ?").get(workflowId) as { status: string; halt_reason: string | null; current_phase_index: number } | undefined;
		return row ? { status: row.status, haltReason: row.halt_reason, currentPhaseIndex: row.current_phase_index } : null;
	});
}

export function readWorkflowProgress(stateRoot: string, workflowId: string): { rounds: number; reviewFindings: number; estimatedChars: number; phases: Array<{ name: string; outcome: string | null }>; escalated: boolean } {
	return withDb(stateRoot, (db) => {
		const phases = db.prepare("SELECT phase_name, chain_id, outcome FROM workflow_phases WHERE workflow_id = ? ORDER BY phase_index, started_at").all(workflowId) as Array<{ phase_name: string; chain_id: string | null; outcome: string | null }>;
		let rounds = 0;
		// The broker's escalate path closes the phase as 'escalated' and marks its chain 'escalated'; halt_reason is free text.
		let escalated = phases.some((p) => p.outcome === "escalated");
		for (const p of phases) {
			if (!p.chain_id) continue;
			const c = db.prepare("SELECT current_round, status FROM relay_chains WHERE chain_id = ?").get(p.chain_id) as { current_round: number; status: string } | undefined;
			rounds += c?.current_round ?? 0;
			if (c?.status === "escalated") escalated = true;
		}
		const findings = db.prepare("SELECT COUNT(*) AS n FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'review' AND orchestrator_verdict = 'findings'").get(workflowId) as { n: number };
		const chars = db.prepare("SELECT COALESCE(SUM(length(request_text) + length(COALESCE(handback_text, ''))), 0) AS n FROM relay_handoff WHERE workflow_id = ?").get(workflowId) as { n: number };
		return { rounds, reviewFindings: findings.n, estimatedChars: chars.n, phases: phases.map((p) => ({ name: p.phase_name, outcome: p.outcome })), escalated };
	});
}

export function readEvaluatorUsage(stateRoot: string, workflowId: string): { primary: UsageTotals | null; fallback: UsageTotals | null; fallbackUsed: boolean; calls: number } {
	return withDb(stateRoot, (db) => {
		const rows = db.prepare("SELECT attempt_kind, outcome, input_tokens, output_tokens FROM relay_evaluator_diagnostics WHERE workflow_id = ?").all(workflowId) as Array<{ attempt_kind: string; outcome: string; input_tokens: number | null; output_tokens: number | null }>;
		const group = (kind: "primary" | "fallback"): UsageTotals | null => {
			let total: UsageTotals = ZERO_USAGE;
			for (const r of rows.filter((x) => x.attempt_kind === kind)) {
				if (r.input_tokens === null || r.output_tokens === null) return null;
				total = addUsage(total, { inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheWriteTokens: 0, cacheReadTokens: 0 });
			}
			return total;
		};
		return {
			primary: group("primary"),
			fallback: group("fallback"),
			// "Exercised" means attempted: a failed fallback call still counts (spec: evaluator_fallback_used).
			fallbackUsed: rows.some((r) => r.attempt_kind === "fallback"),
			calls: rows.length,
		};
	});
}

export function readDaemonHeartbeat(stateRoot: string, collabId: string): string | null {
	return withDb(stateRoot, (db) => {
		const row = db.prepare("SELECT last_heartbeat_at FROM broker_daemon WHERE collab_id = ?").get(collabId) as { last_heartbeat_at: string | null } | undefined;
		return row?.last_heartbeat_at ?? null;
	});
}
