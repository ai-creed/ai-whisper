import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

const TEST_COLLAB_ID = "collab_c1";

function bindAgent(broker: ReturnType<typeof createBrokerRuntime>, agent: "claude" | "codex") {
	broker.control.setSessionBinding({
		collabId: TEST_COLLAB_ID,
		agentType: agent,
		sessionId: `session_${agent}`,
		bindingSource: "adopted",
		now: "2026-04-21T00:00:00Z",
	});
}

function setupCollab(orchestratorEnabled = true) {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	broker.control.startCollab({
		collabId: TEST_COLLAB_ID,
		workspaceRoot: "/tmp",
		displayName: "c1",
		orchestratorEnabled,
		orchestratorMaxRounds: 3,
		now: "2026-04-21T00:00:00Z",
	});
	bindAgent(broker, "claude");
	bindAgent(broker, "codex");
	return broker;
}

describe("workflow-control (read + create)", () => {
	it("createWorkflow inserts a workflow and emits workflow.created", () => {
		const broker = setupCollab();
		const events: Array<{ workflowId: string }> = [];
		broker.events.on("workflow.created", (e) => events.push(e));

		const { workflowId } = broker.control.createWorkflow({
			collabId: TEST_COLLAB_ID,
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});

		expect(workflowId).toMatch(/^wf_/);
		expect(events).toEqual([{ workflowId }]);

		const wf = broker.control.getWorkflow(workflowId);
		expect(wf?.status).toBe("running");
		expect(wf?.currentPhaseIndex).toBe(0);
	});

	it("createWorkflow rejects when orchestrator disabled", () => {
		const broker = setupCollab(false);
		expect(() =>
			broker.control.createWorkflow({
				collabId: TEST_COLLAB_ID,
				workflowType: "spec-driven-development",
				specPath: "docs/spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			}),
		).toThrow(/orchestrator-enabled/);
	});

	it("createWorkflow rejects when an agent in roleBindings is not bound", () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		broker.control.startCollab({
			collabId: TEST_COLLAB_ID,
			workspaceRoot: "/tmp",
			displayName: "c1",
			orchestratorEnabled: true,
			orchestratorMaxRounds: 3,
			now: "2026-04-21T00:00:00Z",
		});
		bindAgent(broker, "claude"); // codex intentionally unbound
		expect(() =>
			broker.control.createWorkflow({
				collabId: TEST_COLLAB_ID,
				workflowType: "spec-driven-development",
				specPath: "docs/spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			}),
		).toThrow(/not bound/);
	});

	it("createWorkflow rejects a second running workflow on the same collab", () => {
		const broker = setupCollab();
		broker.control.createWorkflow({
			collabId: TEST_COLLAB_ID,
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		expect(() =>
			broker.control.createWorkflow({
				collabId: TEST_COLLAB_ID,
				workflowType: "spec-driven-development",
				specPath: "docs/spec2.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:01Z",
			}),
		).toThrow(/already (running|active)/);
	});

	it("getRelayChain returns null for unknown chain", () => {
		const broker = setupCollab();
		expect(broker.control.getRelayChain("relay_ch_nonexistent")).toBeNull();
	});

	it("listWorkflows filters by collab and status", () => {
		const broker = setupCollab();
		broker.control.createWorkflow({
			collabId: TEST_COLLAB_ID,
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		expect(
			broker.control.listWorkflows({ collabId: TEST_COLLAB_ID, status: "running" }),
		).toHaveLength(1);
		expect(
			broker.control.listWorkflows({ collabId: TEST_COLLAB_ID, status: "done" }),
		).toHaveLength(0);
	});

	it("createWorkflow rejects an unknown workflowType", () => {
		const broker = setupCollab();
		expect(() =>
			broker.control.createWorkflow({
				collabId: "collab_c1",
				workflowType: "nonexistent-type",
				specPath: "docs/spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			}),
		).toThrow(/nonexistent-type/);
	});

	it("getWorkflowPhaseRuns returns empty array for a new workflow", () => {
		const broker = setupCollab();
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		expect(broker.control.getWorkflowPhaseRuns(workflowId)).toEqual([]);
	});

	it("createWorkflow accepts the deliberation type", () => {
		const broker = setupCollab();
		const { workflowId } = broker.control.createWorkflow({
			collabId: TEST_COLLAB_ID,
			workflowType: "deliberation",
			specPath: "docs/ideas/x.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		expect(workflowId).toMatch(/^wf_/);
		const wf = broker.control.getWorkflow(workflowId);
		expect(wf?.status).toBe("running");
		expect(wf?.currentPhaseIndex).toBe(0);
	});
});
