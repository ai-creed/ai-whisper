// test/workflow-driver-resume-seed.test.ts
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createWorkflowDriver } from "../packages/broker/src/runtime/workflow-driver.ts";
import { phaseUsesCommitRange, getWorkflowDefinition } from "../packages/broker/src/runtime/workflow-registry.ts";

const NOW = "2026-07-23T00:00:00Z";
const ORIGINAL_BASE = "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1";
const FINISHED_TIP = "ffff222ffff222ffff222ffff222ffff222ffff2";

function setupBroker() {
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
	return broker;
}

/** Insert a running workflow at the given phase with the given context + resumeSeed marker. */
function insertWorkflowAtPhase(
	broker: ReturnType<typeof setupBroker>,
	input: {
		workflowType: string;
		phaseIndex: number;
		context: Record<string, unknown>;
		markerOverrides?: Record<string, unknown>;
	},
) {
	const marker = {
		phaseIndex: input.phaseIndex, resumedAt: NOW,
		haltReason: "max-rounds-reached (5/5)", chainId: null, message: null,
		...input.markerOverrides,
	};
	broker.db
		.prepare(
			`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status,
			   current_phase_index, halt_reason, workflow_context, created_at, updated_at)
			 VALUES ('wf_seed', 'collab_c1', ?, NULL, 'docs/spec.md',
			   '{"implementer":"claude","reviewer":"codex"}', 'running', ?, NULL, ?, ?, ?)`,
		)
		.run(input.workflowType, input.phaseIndex, JSON.stringify({ ...input.context, resumeSeed: marker }), NOW, NOW);
	return "wf_seed";
}

async function runDriverOnce(broker: ReturnType<typeof setupBroker>) {
	const driver = createWorkflowDriver({
		broker,
		headReader: { readHead: async () => FINISHED_TIP },
		sweepIntervalMs: 5,
	});
	driver.start();
	await new Promise((r) => setTimeout(r, 60));
	driver.stop();
}

const latestRequestText = (broker: ReturnType<typeof setupBroker>): string =>
	(broker.db.prepare("SELECT request_text FROM relay_handoff ORDER BY created_at DESC, handoff_id DESC LIMIT 1").get() as { request_text: string }).request_text;

describe("phaseUsesCommitRange", () => {
	it("true for execute, anchorCommitBaseOnEntry, and template-referencing phases; false otherwise", () => {
		const sdd = getWorkflowDefinition("spec-driven-development")!;
		expect(phaseUsesCommitRange(sdd.phases[2]!)).toBe(true);  // plan-execution (execute)
		expect(phaseUsesCommitRange(sdd.phases[3]!)).toBe(true);  // code-review ({commitRange} in templates)
		expect(phaseUsesCommitRange(sdd.phases[0]!)).toBe(false); // spec-refining
		const qt = getWorkflowDefinition("quick-task")!;
		expect(phaseUsesCommitRange(qt.phases[0]!)).toBe(true);   // anchorCommitBaseOnEntry
	});
});

describe("seeded driver kickoff — base-establishing phases (spec §3)", () => {
	it("execute phase inherits the original base instead of re-anchoring to the finished tip", async () => {
		const broker = setupBroker();
		const workflowId = insertWorkflowAtPhase(broker, {
			workflowType: "spec-driven-development", phaseIndex: 2, // plan-execution (execute)
			context: { baseBeforeExecution: ORIGINAL_BASE, commitRange: `${ORIGINAL_BASE}..${FINISHED_TIP}` },
		});
		await runDriverOnce(broker);
		const ctx = broker.control.getWorkflow(workflowId)!.workflowContext as { baseBeforeExecution?: string };
		expect(ctx.baseBeforeExecution).toBe(ORIGINAL_BASE); // NOT FINISHED_TIP
		const text = latestRequestText(broker);
		expect(text).toContain(`${ORIGINAL_BASE}..HEAD`);
		expect(text).toContain("RESUMED PHASE");
	});

	it("anchorCommitBaseOnEntry phase (quick-task) also inherits, and subsequent step templates render live", async () => {
		const broker = setupBroker();
		const STALE = `${ORIGINAL_BASE}..${FINISHED_TIP}`;
		const workflowId = insertWorkflowAtPhase(broker, {
			workflowType: "quick-task", phaseIndex: 0,
			context: { baseBeforeExecution: ORIGINAL_BASE, commitRange: STALE },
		});
		await runDriverOnce(broker);
		const ctx = broker.control.getWorkflow(workflowId)!.workflowContext as { baseBeforeExecution?: string };
		expect(ctx.baseBeforeExecution).toBe(ORIGINAL_BASE);
		expect(latestRequestText(broker)).toContain(`${ORIGINAL_BASE}..HEAD`);

		// Spec §3 "all subsequent step templates": drive one step — implement
		// handback + delivered verdict → the continuation review request must
		// render the live range (renderReviewRequestText → liveReviewCommitRange),
		// never the frozen one.
		const kickoffRow = broker.db
			.prepare("SELECT handoff_id FROM relay_handoff ORDER BY created_at DESC, handoff_id DESC LIMIT 1")
			.get() as { handoff_id: string };
		broker.db
			.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
			.run("implemented; commit deadbee", kickoffRow.handoff_id);
		const result = broker.control.applyOrchestratorVerdict({
			handoffId: kickoffRow.handoff_id, verdict: "delivered", confidence: 0.9,
			reason: "work delivered", now: "2026-07-23T00:10:00Z",
		});
		const reviewText = (broker.db
			.prepare("SELECT request_text FROM relay_handoff WHERE handoff_id = ?")
			.get(result.nextHandoffId as string) as { request_text: string }).request_text;
		expect(reviewText).toContain(`${ORIGINAL_BASE}..HEAD`);
		expect(reviewText.includes(STALE)).toBe(false);
		void workflowId;
	});

	it("no-chain anchor phase with NO pre-existing base: seed omits the commit-range section; ordinary anchoring still records fresh HEAD (spec §2)", async () => {
		// A just-read HEAD is ordinary phase anchoring, not prior-attempt context —
		// it must not feed the seed's commit-range instruction.
		const broker = setupBroker();
		const workflowId = insertWorkflowAtPhase(broker, {
			workflowType: "quick-task", phaseIndex: 0, context: {},
			markerOverrides: { message: "bindings fixed, go" },
		});
		await runDriverOnce(broker);
		const text = latestRequestText(broker);
		expect(text).toContain("RESUMED PHASE");
		expect(text).toContain("bindings fixed, go");
		expect(text).not.toContain("--- Commit range ---");
		const ctx = broker.control.getWorkflow(workflowId)!.workflowContext as { baseBeforeExecution?: string };
		expect(ctx.baseBeforeExecution).toBe(FINISHED_TIP);
	});

	it("seeded execute phase with NO recorded base re-anchors normally (first attempt of this phase)", async () => {
		const broker = setupBroker();
		const workflowId = insertWorkflowAtPhase(broker, {
			workflowType: "spec-driven-development", phaseIndex: 2, context: {},
		});
		await runDriverOnce(broker);
		const ctx = broker.control.getWorkflow(workflowId)!.workflowContext as { baseBeforeExecution?: string };
		expect(ctx.baseBeforeExecution).toBe(FINISHED_TIP); // fresh HEAD read, as today
	});
});

describe("seeded driver kickoff — base-consuming phase (spec §3, halted code-review)", () => {
	it("renders original-base..HEAD with zero occurrences of the frozen range; base untouched", async () => {
		const broker = setupBroker();
		const STALE = `${ORIGINAL_BASE}..${FINISHED_TIP}`;
		const workflowId = insertWorkflowAtPhase(broker, {
			workflowType: "spec-driven-development", phaseIndex: 3, // code-review (review step, no anchor)
			context: { baseBeforeExecution: ORIGINAL_BASE, commitRange: STALE },
		});
		await runDriverOnce(broker);
		const text = latestRequestText(broker);
		expect(text).toContain(`${ORIGINAL_BASE}..HEAD`);
		expect(text.includes(STALE)).toBe(false); // no stale frozen range anywhere
		const ctx = broker.control.getWorkflow(workflowId)!.workflowContext as { baseBeforeExecution?: string };
		expect(ctx.baseBeforeExecution).toBe(ORIGINAL_BASE);

		// Spec §3 "all subsequent step templates", for the base-consuming class:
		// drive the seeded code-review chain findings → fix → delivered → review
		// and assert the later templates render the live range, never the frozen one.
		const kickoffRow = broker.db
			.prepare("SELECT handoff_id FROM relay_handoff ORDER BY created_at DESC, handoff_id DESC LIMIT 1")
			.get() as { handoff_id: string };
		broker.db
			.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
			.run("found issues in the range", kickoffRow.handoff_id);
		const fixResult = broker.control.applyOrchestratorVerdict({
			handoffId: kickoffRow.handoff_id, verdict: "findings", confidence: 0.9,
			reason: "blocking findings", now: "2026-07-23T00:10:00Z",
		});
		const fixText = (broker.db
			.prepare("SELECT request_text FROM relay_handoff WHERE handoff_id = ?")
			.get(fixResult.nextHandoffId as string) as { request_text: string }).request_text;
		expect(fixText.includes(STALE)).toBe(false); // SDD's fix step is the generic wrap — carries no frozen range

		broker.db
			.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
			.run("fixed; commit abc9999def", fixResult.nextHandoffId as string);
		const reviewResult = broker.control.applyOrchestratorVerdict({
			handoffId: fixResult.nextHandoffId as string, verdict: "delivered", confidence: 0.9,
			reason: "fix delivered", now: "2026-07-23T00:11:00Z",
		});
		const reviewText = (broker.db
			.prepare("SELECT request_text FROM relay_handoff WHERE handoff_id = ?")
			.get(reviewResult.nextHandoffId as string) as { request_text: string }).request_text;
		expect(reviewText).toContain(`${ORIGINAL_BASE}..HEAD`); // renderReviewRequestText → liveReviewCommitRange
		expect(reviewText.includes(STALE)).toBe(false);
	});
});

describe("unseeded kickoff — unchanged behavior", () => {
	it("without a marker, kickoff renders the frozen commitRange exactly as today", async () => {
		const broker = setupBroker();
		const STALE = `${ORIGINAL_BASE}..${FINISHED_TIP}`;
		broker.db
			.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status,
				   current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_plain', 'collab_c1', 'spec-driven-development', NULL, 'docs/spec.md',
				   '{"implementer":"claude","reviewer":"codex"}', 'running', 3, NULL, ?, ?, ?)`,
			)
			.run(JSON.stringify({ baseBeforeExecution: ORIGINAL_BASE, commitRange: STALE }), NOW, NOW);
		await runDriverOnce(broker);
		expect(latestRequestText(broker)).toContain(STALE);
	});
});
