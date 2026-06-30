import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertEvaluatorDiagnostic,
	listEvaluatorDiagnosticsByCollab,
	listEvaluatorDiagnosticsByCollabAndChain,
	listEvaluatorDiagnosticsByHandoff,
	deleteEvaluatorDiagnosticsOlderThan,
	type RelayEvaluatorDiagnosticRecord,
} from "../packages/broker/src/storage/repositories/relay-evaluator-diagnostics-repository.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-eval-diag-repo-"));
	return createBrokerRuntime({ sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4602 });
}

function sampleRow(overrides: Partial<RelayEvaluatorDiagnosticRecord> = {}): RelayEvaluatorDiagnosticRecord {
	return {
		evaluatorId: "eval_20260514120000_abcd1234",
		handoffId: "handoff_1",
		collabId: "collab_a",
		chainId: "chain_1",
		workflowId: null,
		phaseRunId: null,
		evaluatorBranch: "legacy",
		evaluatorPromptKey: null,
		handoffStep: null,
		attemptKind: "primary",
		callGroupId: "cg_1",
		provider: "anthropic",
		outcome: "ok",
		verdict: "done",
		confidence: 0.85,
		reason: "deliverable matches request",
		followUpMessageLen: 0,
		latencyMs: 812,
		errorMessage: null,
		inputTokens: 812,
		outputTokens: 96,
		promptSample: "system prompt + payload",
		responseSample: "{\"verdict\":\"done\",...}",
		createdAt: "2026-05-14T12:00:00.000Z",
		...overrides,
	};
}

describe("relay-evaluator-diagnostics repository", () => {
	it("round-trips a row through insert + listByCollab", () => {
		const broker = newBroker();
		try {
			insertEvaluatorDiagnostic(broker.db, sampleRow());
			const rows = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				evaluatorId: "eval_20260514120000_abcd1234",
				outcome: "ok",
				verdict: "done",
				attemptKind: "primary",
				callGroupId: "cg_1",
			});
		} finally {
			void broker.stop();
		}
	});

	it("listByCollab returns newest first and respects limit", () => {
		const broker = newBroker();
		try {
			for (let i = 0; i < 5; i += 1) {
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: `eval_${i}`,
					handoffId: `handoff_${i}`,
					callGroupId: `cg_${i}`,
					createdAt: `2026-05-14T12:0${i}:00.000Z`,
				}));
			}
			const rows = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", 3);
			expect(rows.map((r) => r.evaluatorId)).toEqual(["eval_4", "eval_3", "eval_2"]);
		} finally {
			void broker.stop();
		}
	});

	it("listByCollab with limit:null returns all rows", () => {
		const broker = newBroker();
		try {
			for (let i = 0; i < 25; i += 1) {
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: `eval_n${i}`,
					handoffId: `handoff_n${i}`,
					callGroupId: `cg_n${i}`,
					createdAt: `2026-05-14T12:${String(i).padStart(2, "0")}:00.000Z`,
				}));
			}
			const rows = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", null);
			expect(rows).toHaveLength(25);
		} finally {
			void broker.stop();
		}
	});

	it("listByCollabAndChain filters by both collab and chain", () => {
		const broker = newBroker();
		try {
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "eval_a", handoffId: "h_a", collabId: "x", chainId: "chain_X",
				callGroupId: "cg_a", createdAt: "2026-05-14T10:00:00.000Z",
			}));
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "eval_b", handoffId: "h_b", collabId: "x", chainId: "chain_Y",
				callGroupId: "cg_b", createdAt: "2026-05-14T10:01:00.000Z",
			}));
			const rows = listEvaluatorDiagnosticsByCollabAndChain(broker.db, "x", "chain_X", 20);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.evaluatorId).toBe("eval_a");
		} finally {
			void broker.stop();
		}
	});

	it("listByCollabAndChain does not leak rows from other collabs sharing the chain_id", () => {
		const broker = newBroker();
		try {
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "eval_a", handoffId: "h_a", collabId: "collab_a", chainId: "chain_shared",
				callGroupId: "cg_a", createdAt: "2026-05-14T10:00:00.000Z",
			}));
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "eval_b", handoffId: "h_b", collabId: "collab_b", chainId: "chain_shared",
				callGroupId: "cg_b", createdAt: "2026-05-14T10:01:00.000Z",
			}));

			const rowsA = listEvaluatorDiagnosticsByCollabAndChain(broker.db, "collab_a", "chain_shared", 20);
			expect(rowsA.map((r) => r.evaluatorId)).toEqual(["eval_a"]);

			const rowsB = listEvaluatorDiagnosticsByCollabAndChain(broker.db, "collab_b", "chain_shared", 20);
			expect(rowsB.map((r) => r.evaluatorId)).toEqual(["eval_b"]);
		} finally {
			void broker.stop();
		}
	});

	it("listByHandoff returns both primary and fallback rows for a fallback event", () => {
		const broker = newBroker();
		try {
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "eval_p", handoffId: "h_shared",
				attemptKind: "primary", provider: "anthropic", outcome: "provider_unavailable",
				verdict: null, confidence: null, reason: null, followUpMessageLen: null,
				errorMessage: "ECONNREFUSED",
				callGroupId: "cg_shared",
				createdAt: "2026-05-14T10:00:00.000Z",
			}));
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "eval_f", handoffId: "h_shared",
				attemptKind: "fallback", provider: "ollama", outcome: "ok",
				verdict: "done", confidence: 0.7, reason: "ok",
				callGroupId: "cg_shared",
				createdAt: "2026-05-14T10:00:01.000Z",
			}));
			const rows = listEvaluatorDiagnosticsByHandoff(broker.db, "h_shared");
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.attemptKind)).toEqual(["primary", "fallback"]);
			expect(rows.every((r) => r.callGroupId === "cg_shared")).toBe(true);
		} finally {
			void broker.stop();
		}
	});

	// Used by the dashboard Inspector when there is no chain to scope by (e.g.
	// brand-new workflow with no phase yet, or manual relay panes). Without an
	// SQL-level workflow filter, the fallback mixes diagnostics from sibling
	// workflow runs on the same collab into the displayed Evidence section.
	describe("listByCollab workflowFilter", () => {
		it("scopes to a specific workflow_id when { workflowId } is passed", () => {
			const broker = newBroker();
			try {
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_a", handoffId: "h_a", workflowId: "wf_a",
					callGroupId: "cg_a", createdAt: "2026-05-14T10:00:00.000Z",
				}));
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_b", handoffId: "h_b", workflowId: "wf_b",
					callGroupId: "cg_b", createdAt: "2026-05-14T10:01:00.000Z",
				}));
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_m", handoffId: "h_m", workflowId: null,
					callGroupId: "cg_m", createdAt: "2026-05-14T10:02:00.000Z",
				}));
				const rows = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", 50, { workflowFilter: { workflowId: "wf_a" } });
				expect(rows.map((r) => r.evaluatorId)).toEqual(["eval_a"]);
				expect(rows.every((r) => r.workflowId === "wf_a")).toBe(true);
			} finally {
				void broker.stop();
			}
		});

		it("scopes to workflow_id IS NULL when { manualOnly: true } is passed", () => {
			const broker = newBroker();
			try {
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_a", handoffId: "h_a", workflowId: "wf_a",
					callGroupId: "cg_a", createdAt: "2026-05-14T10:00:00.000Z",
				}));
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_m1", handoffId: "h_m1", workflowId: null,
					callGroupId: "cg_m1", createdAt: "2026-05-14T10:01:00.000Z",
				}));
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_m2", handoffId: "h_m2", workflowId: null,
					callGroupId: "cg_m2", createdAt: "2026-05-14T10:02:00.000Z",
				}));
				const rows = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", 50, { workflowFilter: { manualOnly: true } });
				expect(rows.map((r) => r.evaluatorId).sort()).toEqual(["eval_m1", "eval_m2"]);
				expect(rows.every((r) => r.workflowId === null)).toBe(true);
			} finally {
				void broker.stop();
			}
		});

		it("absence of workflowFilter preserves the original collab-only behavior (back-compat)", () => {
			const broker = newBroker();
			try {
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_a", handoffId: "h_a", workflowId: "wf_a",
					callGroupId: "cg_a", createdAt: "2026-05-14T10:00:00.000Z",
				}));
				insertEvaluatorDiagnostic(broker.db, sampleRow({
					evaluatorId: "eval_b", handoffId: "h_b", workflowId: "wf_b",
					callGroupId: "cg_b", createdAt: "2026-05-14T10:01:00.000Z",
				}));
				const rows = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", 50);
				expect(rows.map((r) => r.evaluatorId).sort()).toEqual(["eval_a", "eval_b"]);
			} finally {
				void broker.stop();
			}
		});
	});

	it("round-trips the new openai and agent-cli provider literals through the TEXT column", () => {
		const broker = newBroker();
		insertEvaluatorDiagnostic(broker.db, sampleRow({ provider: "openai", handoffId: "handoff_openai", evaluatorId: "eval_openai_1" }));
		insertEvaluatorDiagnostic(broker.db, sampleRow({ provider: "agent-cli", handoffId: "handoff_agentcli", evaluatorId: "eval_agentcli_1" }));

		const openai = listEvaluatorDiagnosticsByHandoff(broker.db, "handoff_openai");
		const agentCli = listEvaluatorDiagnosticsByHandoff(broker.db, "handoff_agentcli");

		expect(openai[0]?.provider).toBe("openai");
		expect(agentCli[0]?.provider).toBe("agent-cli");
	});

	it("deleteOlderThan removes rows strictly older than the cutoff", () => {
		const broker = newBroker();
		try {
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "old", handoffId: "h_old", callGroupId: "cg_old",
				createdAt: "2026-04-01T00:00:00.000Z",
			}));
			insertEvaluatorDiagnostic(broker.db, sampleRow({
				evaluatorId: "new", handoffId: "h_new", callGroupId: "cg_new",
				createdAt: "2026-05-13T00:00:00.000Z",
			}));
			const deleted = deleteEvaluatorDiagnosticsOlderThan(broker.db, "2026-05-01T00:00:00.000Z");
			expect(deleted).toBe(1);
			const remaining = listEvaluatorDiagnosticsByCollab(broker.db, "collab_a", 10);
			expect(remaining.map((r) => r.evaluatorId)).toEqual(["new"]);
		} finally {
			void broker.stop();
		}
	});
});
