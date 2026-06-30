import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createBrokerRuntime,
	insertBrokerDaemon,
	setBrokerDaemonEvaluatorStatus,
} from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-evalpreflight-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "x.sqlite"),
		host: "127.0.0.1",
		port: 4731,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
}

function seedCollab(broker: ReturnType<typeof newBroker>) {
	const now = new Date().toISOString();
	broker.control.startCollab({
		collabId: "collab_y",
		workspaceRoot: "/tmp/y",
		displayName: "y",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 5,
		now,
	});
	for (const agent of ["codex", "claude"] as const) {
		broker.control.setSessionBinding({
			collabId: "collab_y",
			agentType: agent,
			sessionId: `session_${agent}_y`,
			bindingSource: "adopted",
			now,
		});
	}
}

function seedDaemon(broker: ReturnType<typeof newBroker>) {
	const now = new Date().toISOString();
	insertBrokerDaemon(broker.db, {
		collabId: "collab_y",
		host: "127.0.0.1",
		port: 4731,
		startedAt: now,
		lastHeartbeatAt: now,
	});
}

const now = new Date().toISOString();
const baseInput = {
	collabId: "collab_y",
	workflowType: "spec-driven-development" as const,
	specPath: "/tmp/spec.md",
	now,
};

describe("evaluator preflight in runWorkflowStart", () => {
	it("missing_anthropic_key → rejects with auth.json / ANTHROPIC_API_KEY remediation", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			seedDaemon(broker);
			setBrokerDaemonEvaluatorStatus(broker.db, {
				collabId: "collab_y",
				status: "missing_anthropic_key",
			});
			await expect(runWorkflowStart({ broker, ...baseInput })).rejects.toThrow(
				/auth\.json|ANTHROPIC_API_KEY/,
			);
		} finally {
			await broker.stop();
		}
	});

	it("invalid_config → rejects with config/JSON/~/.ai-whisper remediation", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			seedDaemon(broker);
			setBrokerDaemonEvaluatorStatus(broker.db, {
				collabId: "collab_y",
				status: "invalid_config",
			});
			await expect(runWorkflowStart({ broker, ...baseInput })).rejects.toThrow(
				/config|JSON|~\/.ai-whisper/,
			);
		} finally {
			await broker.stop();
		}
	});

	it("ready → resolves to { workflowId }", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			seedDaemon(broker);
			setBrokerDaemonEvaluatorStatus(broker.db, {
				collabId: "collab_y",
				status: "ready",
			});
			const result = await runWorkflowStart({ broker, ...baseInput });
			expect(result.workflowId).toMatch(/^wf_/);
		} finally {
			await broker.stop();
		}
	});

	it("no daemon row (null status → unknown) → proceeds", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			// intentionally no seedDaemon — getBrokerDaemonByCollab returns null → "unknown"
			const result = await runWorkflowStart({ broker, ...baseInput });
			expect(result.workflowId).toMatch(/^wf_/);
		} finally {
			await broker.stop();
		}
	});

	it("disabled → proceeds at preflight (createWorkflow handles orchestrator logic)", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			seedDaemon(broker);
			setBrokerDaemonEvaluatorStatus(broker.db, {
				collabId: "collab_y",
				status: "disabled",
			});
			// seedCollab enables orchestrator, so createWorkflow succeeds — confirms
			// preflight did NOT block on "disabled".
			const result = await runWorkflowStart({ broker, ...baseInput });
			expect(result.workflowId).toMatch(/^wf_/);
		} finally {
			await broker.stop();
		}
	});

	it("missing_openai_key → rejects with OPENAI_API_KEY remediation", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			seedDaemon(broker);
			setBrokerDaemonEvaluatorStatus(broker.db, { collabId: "collab_y", status: "missing_openai_key" });
			await expect(runWorkflowStart({ broker, ...baseInput })).rejects.toThrow(/OPENAI_API_KEY/);
		} finally {
			broker.db.close();
		}
	});
});
