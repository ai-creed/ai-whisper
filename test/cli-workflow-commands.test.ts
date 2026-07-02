import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";
import { runWorkflowList } from "../packages/cli/src/commands/workflow/list.ts";
import { runWorkflowResume } from "../packages/cli/src/commands/workflow/resume.ts";
import { runWorkflowPause } from "../packages/cli/src/commands/workflow/pause.ts";
import { runWorkflowCancel } from "../packages/cli/src/commands/workflow/cancel.ts";
import { runWorkflowComplete } from "../packages/cli/src/commands/workflow/complete.ts";
import { runWorkflowTypes } from "../packages/cli/src/commands/workflow/types.ts";

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
			sessionId: `session_${agent}`,
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	return broker;
}

describe("whisper workflow commands", () => {
	it("start creates a workflow and returns the ID", async () => {
		const broker = boot();
		const result = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		expect(result.workflowId).toMatch(/^wf_/);
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("list returns running workflows", async () => {
		const broker = boot();
		await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		const list = await runWorkflowList({ broker, collabId: "collab_c1" });
		expect(list).toHaveLength(1);
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("types enumerates registry", async () => {
		const types = await runWorkflowTypes();
		expect(types).toContain("spec-driven-development");
	});

	it("cancel + resume rejects", async () => {
		const broker = boot();
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		await runWorkflowCancel({ broker, workflowId, now: "2026-04-21T00:00:01Z" });
		await expect(
			runWorkflowResume({ broker, workflowId, now: "2026-04-21T00:00:02Z" }),
		).rejects.toThrow(/canceled/);
		await broker.stop();
	});

	it("pause flips a running workflow to paused", async () => {
		const broker = boot();
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		await runWorkflowPause({ broker, workflowId, now: "2026-05-27T00:01:00Z" });
		expect(broker.control.getWorkflow(workflowId)!.status).toBe("paused");
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("resume forwards --message into the resume notice", async () => {
		const broker = boot();
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		await runWorkflowPause({ broker, workflowId, now: "2026-05-27T00:01:00Z" });
		await runWorkflowResume({
			broker,
			workflowId,
			now: "2026-05-27T00:02:00Z",
			message: "re-read the spec",
		});
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("running");
		// The CLI forwarded --message; the broker delivered it via whichever path applies.
		// This fresh workflow has a pending kickoff handoff, so the notice is baked into
		// that handoff's request text (consumed off the context). Either way, the operator
		// note must be present in a deliverable surface for this workflow.
		const noticeOnContext = (wf.workflowContext as { resumeNotice?: string | null }).resumeNotice ?? "";
		const bakedHandoff = broker.db
			.prepare(
				"SELECT request_text FROM relay_handoff WHERE workflow_id = ? AND request_text LIKE '%Operator note: re-read the spec%' LIMIT 1",
			)
			.get(workflowId) as { request_text: string } | undefined;
		expect(noticeOnContext.includes("Operator note: re-read the spec") || !!bakedHandoff).toBe(true);
		// Drain the workflow.resumed driver kickoff (a no-op given the open phase run)
		// before closing the db, so its setImmediate doesn't fire post-stop.
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("complete marks a halted workflow done", async () => {
		const broker = boot();
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		broker.control.haltWorkflow({
			workflowId,
			reason: "escalated: env blocker",
			now: "2026-04-21T00:01:00Z",
		});
		await runWorkflowComplete({
			broker,
			workflowId,
			now: "2026-04-21T00:02:00Z",
		});
		const wf = broker.control.getWorkflow(workflowId);
		expect(wf?.status).toBe("done");
		expect(wf?.haltReason).toBe("marked done by operator");
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("complete rejects a non-halted workflow", async () => {
		const broker = boot();
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		await expect(
			runWorkflowComplete({
				broker,
				workflowId,
				now: "2026-04-21T00:02:00Z",
			}),
		).rejects.toThrow("only halted (escalated) workflows can be marked done");
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});
});
