import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createWorkflowDriver } from "../packages/broker/src/runtime/workflow-driver.ts";

function boot() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	broker.control.startCollab({
		collabId: "collab_c1",
		workspaceRoot: "/tmp",
		displayName: "c1",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: "2026-04-21T00:00:00Z",
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: "collab_c1",
			agentType: agent,
			sessionId: agent === "claude" ? "session_claude" : "session_codex",
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	return broker;
}

describe("WorkflowDriver", () => {
	it("kickoff handoff text contains rendered reviewMode (no literal placeholder)", async () => {
		const broker = boot();
		const driver = createWorkflowDriver({
			broker,
			headReader: { readHead: async () => "abc1234" },
			sweepIntervalMs: 0,
		});
		driver.start();
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		const row = broker.db
			.prepare(
				"SELECT request_text FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at ASC LIMIT 1",
			)
			.get(workflowId) as { request_text: string } | undefined;
		const firstKickoffText = row?.request_text ?? "";
		expect(firstKickoffText).toContain("reviewMode: phase-review");
		expect(firstKickoffText).not.toContain("{reviewMode}");
		driver.stop();
	});

	it("on workflow.created → kickoff phase 0 via beginPhaseRun", async () => {
		const broker = boot();
		const driver = createWorkflowDriver({
			broker,
			headReader: { readHead: async () => "abc1234" },
			sweepIntervalMs: 0, // disable sweep
		});
		driver.start();
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		expect(broker.control.getWorkflowPhaseRuns(workflowId)).toHaveLength(1);
		driver.stop();
	});

	it("recovery sweep kicks off missed workflow when no phase run exists", async () => {
		const broker = boot();
		// Insert a workflow row directly to simulate a dropped workflow.created event
		broker.db
			.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_seed', 'collab_c1', 'spec-driven-development', NULL, 'docs/spec.md', '{"implementer":"claude","reviewer":"codex"}', 'running', 0, NULL, '{}', '2026-04-21T00:00:00Z', '2026-04-21T00:00:00Z')`,
			)
			.run();

		const driver = createWorkflowDriver({
			broker,
			headReader: { readHead: async () => "abc1234" },
			sweepIntervalMs: 5,
		});
		driver.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(broker.control.getWorkflowPhaseRuns("wf_seed").length).toBeGreaterThan(0);
		driver.stop();
	});

	it("on workflow.resumed → kickoff current phase", async () => {
		const broker = boot();
		// Create workflow and begin a phase run to simulate it being in progress
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		// Halt the workflow so we can resume it
		broker.control.haltWorkflow({
			workflowId,
			reason: "test halt",
			now: "2026-04-21T00:01:00Z",
		});

		const driver = createWorkflowDriver({
			broker,
			headReader: { readHead: async () => "abc1234" },
			sweepIntervalMs: 0,
		});
		driver.start();

		// Resume triggers workflow.resumed event → driver should kickoff
		broker.control.resumeWorkflow({
			workflowId,
			now: "2026-04-21T00:02:00Z",
		});
		await new Promise((r) => setImmediate(r));
		expect(broker.control.getWorkflowPhaseRuns(workflowId)).toHaveLength(1);
		driver.stop();
	});

	it("deliberation: renders the objectives kickoff with the run-dir resolved and no placeholder leaks", async () => {
		const broker = boot();
		const driver = createWorkflowDriver({
			broker,
			headReader: { readHead: async () => "abc1234" },
			sweepIntervalMs: 0,
		});
		driver.start();
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "deliberation",
			specPath: "docs/ideas/14all-samantha.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		const row = broker.db
			.prepare(
				"SELECT request_text FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at ASC LIMIT 1",
			)
			.get(workflowId) as { request_text: string } | undefined;
		const firstKickoffText = row?.request_text ?? "";
		expect(firstKickoffText).toContain(".ai-whisper/deliberation/");
		expect(firstKickoffText).not.toContain("{deliberationDir}");
		expect(firstKickoffText).not.toContain("{findingsPath}");
		driver.stop();
	});

	it("unbound target agent → workflow halted with descriptive reason", async () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		broker.control.startCollab({
			collabId: "collab_c1",
			workspaceRoot: "/tmp",
			displayName: "c1",
			orchestratorEnabled: true,
			orchestratorMaxRounds: 3,
			now: "2026-04-21T00:00:00Z",
		});
		// Bind only claude; codex is unbound
		broker.control.setSessionBinding({
			collabId: "collab_c1",
			agentType: "claude",
			sessionId: "session_claude",
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
		// Insert workflow directly (createWorkflow would check bindings)
		broker.db
			.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_x', 'collab_c1', 'spec-driven-development', NULL, 'docs/spec.md', '{"implementer":"claude","reviewer":"codex"}', 'running', 0, NULL, '{}', '2026-04-21T00:00:00Z', '2026-04-21T00:00:00Z')`,
			)
			.run();
		const driver = createWorkflowDriver({
			broker,
			headReader: { readHead: async () => "abc1234" },
			sweepIntervalMs: 5,
		});
		driver.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(broker.control.getWorkflow("wf_x")?.status).toBe("halted");
		expect(broker.control.getWorkflow("wf_x")?.haltReason).toMatch(/not bound/);
		driver.stop();
	});
});
