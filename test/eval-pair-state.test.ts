import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDatabase } from "@ai-whisper/broker";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundAgents, readCollabForWorkspace, readEvaluatorUsage, readWorkflow, readWorkflowProgress } from "../eval/runner/arms/pair-state.ts";

describe("pair-state read-only queries", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reads bindings, workflow status, progress counters and evaluator usage from a real-schema DB", () => {
		root = mkdtempSync(join(tmpdir(), "eval-state-"));
		const db = openDatabase(join(root, "state.db"));
		applyMigrations(db);
		const t = "2026-08-19T00:00:00.000Z";
		db.prepare("INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("c1", "/ws", "ws", "active", t, t);
		db.prepare("INSERT INTO session_binding (collab_id, agent_type, binding_state, updated_at) VALUES (?,?,?,?)").run("c1", "claude", "bound", t);
		db.prepare("INSERT INTO session_binding (collab_id, agent_type, binding_state, updated_at) VALUES (?,?,?,?)").run("c1", "codex", "pending_attach", t);
		db.prepare("INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
			.run("wf1", "c1", "quick-task", "/ws/.ai-whisper/tasks/brief.md", JSON.stringify({ implementer: "claude", reviewer: "codex" }), "halted", 0, "max-rounds-reached (5/5)", "{}", t, t);
		db.prepare("INSERT INTO relay_chains (chain_id, collab_id, status, current_round, max_rounds, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("ch1", "c1", "escalated", 5, 5, t, t);
		db.prepare("INSERT INTO workflow_phases (phase_run_id, workflow_id, phase_index, phase_name, chain_id, started_at, ended_at, outcome) VALUES (?,?,?,?,?,?,?,?)").run("p1", "wf1", 0, "implement-and-review", "ch1", t, t, "escalated");
		const ins = db.prepare("INSERT INTO relay_handoff (handoff_id, collab_id, sender_agent, target_agent, request_text, status, created_at, last_activity_at, chain_id, workflow_id, handoff_step, handback_text, orchestrator_verdict) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
		ins.run("h1", "c1", "claude", "codex", "x".repeat(400), "resolved", t, t, "ch1", "wf1", "review", "y".repeat(100), "findings");
		ins.run("h2", "c1", "claude", "codex", "x".repeat(100), "resolved", t, t, "ch1", "wf1", "review", null, "approve");
		const evIns = db.prepare("INSERT INTO relay_evaluator_diagnostics (evaluator_id, handoff_id, collab_id, workflow_id, evaluator_branch, attempt_kind, call_group_id, provider, outcome, latency_ms, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
		evIns.run("e1", "h1", "c1", "wf1", "workflow", "primary", "g1", "anthropic", "error", 10, null, null, t);
		evIns.run("e2", "h1", "c1", "wf1", "workflow", "fallback", "g1", "openai", "ok", 10, 500, 50, t);
		db.close();

		expect(readBoundAgents(root, "c1")).toEqual(["claude"]);
		expect(readCollabForWorkspace(root, "/ws")).toEqual({ collabId: "c1", status: "active" });
		expect(readWorkflow(root, "wf1")).toEqual({ status: "halted", haltReason: "max-rounds-reached (5/5)", currentPhaseIndex: 0 });
		expect(readWorkflowProgress(root, "wf1")).toEqual({ rounds: 5, reviewFindings: 1, estimatedChars: 600, phases: [{ name: "implement-and-review", outcome: "escalated" }], escalated: true });
		const ev = readEvaluatorUsage(root, "wf1");
		expect(ev.fallbackUsed).toBe(true);
		expect(ev.calls).toBe(2);
		expect(ev.primary).toBeNull(); // e1 (primary) has null tokens → primary group unmetered
		expect(ev.fallback).toEqual({ inputTokens: 500, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 }); // fallback group metered separately
	});

	it("returns null for an unknown workflow and never writes", () => {
		root = mkdtempSync(join(tmpdir(), "eval-state-"));
		const db = openDatabase(join(root, "state.db")); applyMigrations(db); db.close();
		expect(readWorkflow(root, "nope")).toBeNull();
		expect(readCollabForWorkspace(root, "/none")).toBeNull();
	});

	it("flags escalation from structured state: an escalated phase outcome or an escalated phase chain", () => {
		root = mkdtempSync(join(tmpdir(), "eval-state-"));
		const db = openDatabase(join(root, "state.db")); applyMigrations(db);
		const t = "2026-08-19T00:00:00.000Z";
		db.prepare("INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("c1", "/ws", "ws", "active", t, t);
		const wf = db.prepare("INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
		const chain = db.prepare("INSERT INTO relay_chains (chain_id, collab_id, status, current_round, max_rounds, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
		const phase = db.prepare("INSERT INTO workflow_phases (phase_run_id, workflow_id, phase_index, phase_name, chain_id, started_at, ended_at, outcome) VALUES (?,?,?,?,?,?,?,?)");
		wf.run("wf-chain", "c1", "quick-task", "x", "{}", "halted", 0, "low-confidence: reviewer verdict unclear", "{}", t, t);
		chain.run("ch-esc", "c1", "escalated", 2, 5, t, t);
		phase.run("p-chain", "wf-chain", 0, "implement-and-review", "ch-esc", t, null, null);
		wf.run("wf-plain", "c1", "quick-task", "x", "{}", "halted", 0, "canceled by operator", "{}", t, t);
		chain.run("ch-ok", "c1", "active", 1, 5, t, t);
		phase.run("p-plain", "wf-plain", 0, "implement-and-review", "ch-ok", t, null, null);
		db.close();
		expect(readWorkflowProgress(root, "wf-chain").escalated).toBe(true);
		expect(readWorkflowProgress(root, "wf-plain").escalated).toBe(false);
	});
});
