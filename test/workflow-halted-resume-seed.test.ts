// test/workflow-halted-resume-seed.test.ts
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { readResumeSeedMarker } from "../packages/broker/src/control/resume-seed.ts";

const NOW = "2026-07-23T00:00:00Z";

export function setupHaltedAtMaxRounds() {
	const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
	broker.control.startCollab({
		collabId: "collab_c1", workspaceRoot: "/tmp", displayName: "c1",
		orchestratorEnabled: true, orchestratorMaxRounds: 3, now: NOW,
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: "collab_c1", agentType: agent, sessionId: `session_${agent}`,
			bindingSource: "adopted", now: NOW,
		});
	}
	const { workflowId } = broker.control.createWorkflow({
		collabId: "collab_c1", workflowType: "spec-driven-development", specPath: "docs/spec.md",
		roleBindings: { implementer: "claude", reviewer: "codex" }, now: NOW,
	});
	const { handoffId, chainId } = broker.control.beginPhaseRun({
		workflowId, phaseIndex: 0, phaseName: "spec-refining", initialHandoffStep: "review",
		kickoffText: "Review the spec.", sender: "claude", target: "codex",
		maxRounds: 1, now: "2026-07-23T00:01:00Z",
	});
	// Give the round a handback, then escalate via findings-at-max-rounds.
	broker.db
		.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
		.run("final round handback: still failing on X", handoffId);
	broker.control.applyOrchestratorVerdict({
		handoffId, verdict: "findings", confidence: 0.9, reason: "unresolved findings",
		now: "2026-07-23T00:02:00Z",
	});
	const wf = broker.control.getWorkflow(workflowId);
	if (wf?.status !== "halted") throw new Error(`setup expected halted, got ${wf?.status}`);
	return { broker, workflowId, chainId, haltReason: wf.haltReason as string };
}

describe("resumeHaltedWorkflow — seed marker (spec §1, D4)", () => {
	it("captures exact halt reason, chain id, and message into the marker; clears halt_reason", () => {
		const { broker, workflowId, chainId, haltReason } = setupHaltedAtMaxRounds();
		expect(haltReason).toBe("max-rounds-reached (1/1)");

		broker.control.resumeWorkflow({
			workflowId, now: "2026-07-23T00:03:00Z", message: "look at the fixture setup",
		});

		const wf = broker.control.getWorkflow(workflowId);
		expect(wf?.status).toBe("running");
		expect(wf?.haltReason).toBeNull();
		const marker = readResumeSeedMarker(wf!.workflowContext);
		expect(marker).not.toBeNull();
		expect(marker!.phaseIndex).toBe(0);
		expect(marker!.haltReason).toBe("max-rounds-reached (1/1)"); // the exact pre-resume string
		expect(marker!.chainId).toBe(chainId);
		expect(marker!.message).toBe("look at the fixture setup");
	});

	it("no-chain halt (no phase run ever created): marker has null chainId, still carries reason and message", () => {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
		broker.control.startCollab({
			collabId: "collab_c1", workspaceRoot: "/tmp", displayName: "c1",
			orchestratorEnabled: true, orchestratorMaxRounds: 3, now: NOW,
		});
		broker.db
			.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status,
				   current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_x', 'collab_c1', 'spec-driven-development', NULL, 'docs/spec.md',
				   '{"implementer":"claude","reviewer":"codex"}', 'halted', 0,
				   'implementer agent "claude" is not bound on collab collab_c1', '{}', ?, ?)`,
			)
			.run(NOW, NOW);

		broker.control.resumeWorkflow({ workflowId: "wf_x", now: "2026-07-23T00:03:00Z", message: "bindings fixed" });

		const wf = broker.control.getWorkflow("wf_x");
		const marker = readResumeSeedMarker(wf!.workflowContext);
		expect(marker!.chainId).toBeNull();
		expect(marker!.haltReason).toContain("not bound");
		expect(marker!.message).toBe("bindings fixed");
	});

	it("no message → marker.message is null", () => {
		const { broker, workflowId } = setupHaltedAtMaxRounds();
		broker.control.resumeWorkflow({ workflowId, now: "2026-07-23T00:03:00Z" });
		const marker = readResumeSeedMarker(broker.control.getWorkflow(workflowId)!.workflowContext);
		expect(marker!.message).toBeNull();
	});

	it("halted workflow whose latest phase run ended done (ralph maxIterations halt shape) → chainId null", () => {
		// A ralph maxIterations halt closes its chain/run as `done` and THEN halts
		// the workflow — the done chain is not a failed attempt and must not seed.
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
		broker.control.startCollab({
			collabId: "collab_c1", workspaceRoot: "/tmp", displayName: "c1",
			orchestratorEnabled: true, orchestratorMaxRounds: 3, now: NOW,
		});
		broker.db
			.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status,
				   current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_ralph', 'collab_c1', 'ralph-loop', NULL, 'docs/GOAL.md',
				   '{"implementer":"claude","reviewer":"codex"}', 'halted', 0,
				   'ralph loop hit maxIterations cap (5) without completion', '{}', ?, ?)`,
			)
			.run(NOW, NOW);
		broker.db
			.prepare(
				`INSERT INTO workflow_phases (phase_run_id, workflow_id, phase_index, phase_name, chain_id, started_at, ended_at, outcome)
				 VALUES ('wfp_done', 'wf_ralph', 0, 'ralph-loop', 'ch_done', ?, ?, 'done')`,
			)
			.run(NOW, "2026-07-23T00:02:00Z");

		broker.control.resumeWorkflow({ workflowId: "wf_ralph", now: "2026-07-23T00:03:00Z", message: "keep grinding" });

		const marker = readResumeSeedMarker(broker.control.getWorkflow("wf_ralph")!.workflowContext);
		expect(marker!.chainId).toBeNull(); // done chain excluded — only escalated runs seed
		expect(marker!.haltReason).toContain("maxIterations");
		expect(marker!.message).toBe("keep grinding");
	});
});
