import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createBrokerRuntime,
	insertBrokerDaemon,
	setBrokerDaemonEvaluatorStatus,
} from "../packages/broker/src/index.ts";
import { runWorkflowStart, type WorkflowStartDeps } from "../packages/cli/src/commands/workflow/start.ts";

const COLLAB_ID = "collab_qtgate";
const SPEC_PATH = "/tmp/quick-task-brief.md";

// Missing "## Acceptance checks" section + a 6-file (over the 5-file cap) scope list.
const INVALID_BRIEF = `## Task
Do the thing.

## Approved approach
Approach text.

## Scope
- a.ts
- b.ts
- c.ts
- d.ts
- e.ts
- f.ts
`;

const VALID_BRIEF = `## Task
Add a helper.

## Approved approach
Do X.

## Scope
- src/helper.ts
- test/helper.test.ts

## Acceptance checks
- tests pass
`;

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-qtgate-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "x.sqlite"),
		host: "127.0.0.1",
		port: 4733,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
}

// broker_daemon rows FK-reference collabs, so seed the collab row (via the real
// control, only for FK satisfaction) before inserting the daemon row. Preflight
// itself only reads the daemon row off deps.broker.db with evaluatorStatus
// "ready" so the gate under test is reached.
function seedReadyDaemon(broker: ReturnType<typeof newBroker>) {
	const now = new Date().toISOString();
	broker.control.startCollab({
		collabId: COLLAB_ID,
		workspaceRoot: "/tmp/qtgate",
		displayName: "qtgate",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 5,
		now,
	});
	insertBrokerDaemon(broker.db, {
		collabId: COLLAB_ID,
		host: "127.0.0.1",
		port: 4733,
		startedAt: now,
		lastHeartbeatAt: now,
	});
	setBrokerDaemonEvaluatorStatus(broker.db, { collabId: COLLAB_ID, status: "ready" });
}

// Stub control: createWorkflow records calls; listSessionBindings returns two
// bound agents so role resolution succeeds without a real collab/session setup.
function stubControl(): WorkflowStartDeps["broker"]["control"] {
	return {
		createWorkflow: vi.fn(() => ({ workflowId: "wf_stub" })),
		listSessionBindings: vi.fn(() => [
			{ agentType: "claude", bindingState: "bound" },
			{ agentType: "codex", bindingState: "bound" },
		]),
	};
}

function baseDeps(
	broker: ReturnType<typeof newBroker>,
	overrides: Partial<WorkflowStartDeps> = {},
): WorkflowStartDeps {
	return {
		broker: { db: broker.db, control: stubControl() },
		collabId: COLLAB_ID,
		workflowType: "quick-task",
		specPath: SPEC_PATH,
		now: new Date().toISOString(),
		...overrides,
	};
}

describe("quick-task scope gate in runWorkflowStart", () => {
	it("rejects an invalid brief with every violation plus the remedy, and never persists", async () => {
		const broker = newBroker();
		try {
			seedReadyDaemon(broker);
			const deps = baseDeps(broker, { readTaskBrief: () => INVALID_BRIEF });
			await expect(runWorkflowStart(deps)).rejects.toThrow(
				"Task brief failed the quick-task scope gate:\n" +
					"  - missing or empty required section \"## Acceptance checks\"\n" +
					"  - scope declares 6 non-test files; the cap is 5\n" +
					"Split the task or use spec-driven-development.",
			);
			expect(deps.broker.control.createWorkflow).not.toHaveBeenCalled();
		} finally {
			await broker.stop();
		}
	});

	it("rejects an unreadable brief and never persists", async () => {
		const broker = newBroker();
		try {
			seedReadyDaemon(broker);
			const deps = baseDeps(broker, {
				readTaskBrief: () => {
					throw new Error("ENOENT: no such file");
				},
			});
			await expect(runWorkflowStart(deps)).rejects.toThrow(
				`Task brief not readable at ${SPEC_PATH}. Check the path and try again.`,
			);
			expect(deps.broker.control.createWorkflow).not.toHaveBeenCalled();
		} finally {
			await broker.stop();
		}
	});

	it("resolves and creates the workflow when the brief passes the gate", async () => {
		const broker = newBroker();
		try {
			seedReadyDaemon(broker);
			const deps = baseDeps(broker, { readTaskBrief: () => VALID_BRIEF });
			const result = await runWorkflowStart(deps);
			expect(result.workflowId).toBe("wf_stub");
			expect(deps.broker.control.createWorkflow).toHaveBeenCalledTimes(1);
			expect(deps.broker.control.createWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({ workflowType: "quick-task" }),
			);
		} finally {
			await broker.stop();
		}
	});

	it("never reads the brief for a non-quick-task workflow type", async () => {
		const broker = newBroker();
		try {
			seedReadyDaemon(broker);
			const readTaskBrief = vi.fn(() => VALID_BRIEF);
			const deps = baseDeps(broker, {
				workflowType: "spec-driven-development",
				readTaskBrief,
			});
			const result = await runWorkflowStart(deps);
			expect(readTaskBrief).not.toHaveBeenCalled();
			expect(result.workflowId).toBe("wf_stub");
			expect(deps.broker.control.createWorkflow).toHaveBeenCalledTimes(1);
		} finally {
			await broker.stop();
		}
	});
});
