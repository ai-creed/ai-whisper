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

describe("beginPhaseRun — seed consumption (spec §2, D1)", () => {
	function resumeAndKickoff(opts: { message?: string } = {}) {
		const s = setupHaltedAtMaxRounds();
		broker_control_resume(s.broker, s.workflowId, opts.message);
		return s;
	}
	function broker_control_resume(broker: ReturnType<typeof setupHaltedAtMaxRounds>["broker"], workflowId: string, message?: string) {
		broker.control.resumeWorkflow({
			workflowId, now: "2026-07-23T00:03:00Z",
			...(message !== undefined ? { message } : {}),
		});
	}
	function kickoff(s: ReturnType<typeof setupHaltedAtMaxRounds>, extra: Record<string, unknown> = {}) {
		return s.broker.control.beginPhaseRun({
			workflowId: s.workflowId, phaseIndex: 0, phaseName: "spec-refining",
			initialHandoffStep: "review", kickoffText: "Review the spec.",
			sender: "claude", target: "codex", maxRounds: 1,
			now: "2026-07-23T00:04:00Z", ...extra,
		});
	}
	const requestTextOf = (s: ReturnType<typeof setupHaltedAtMaxRounds>, handoffId: string): string =>
		(s.broker.db.prepare("SELECT request_text FROM relay_handoff WHERE handoff_id = ?").get(handoffId) as { request_text: string }).request_text;

	it("amnesic-resume fix: seeded kickoff contains preamble, exact halt reason, final handback, and normal kickoff", () => {
		const s = resumeAndKickoff({ message: "check the fixture" });
		const { handoffId } = kickoff(s);
		const text = requestTextOf(s, handoffId);
		expect(text).toContain("RESUMED PHASE");
		expect(text).toContain("Halt reason: max-rounds-reached (1/1)");
		expect(text).toContain("final round handback: still failing on X");
		expect(text).toContain("check the fixture");
		expect(text.endsWith("Review the spec.")).toBe(true); // normal kickoff appended last
	});

	it("seed consumed after one kickoff; a later re-halt + re-resume seeds anew", () => {
		const s = resumeAndKickoff();
		const first = kickoff(s);
		expect(readResumeSeedMarker(s.broker.control.getWorkflow(s.workflowId)!.workflowContext)).toBeNull();
		// Close the run, then start again: plain kickoff.
		s.broker.control.applyOrchestratorVerdict({
			handoffId: first.handoffId, verdict: "findings", confidence: 0.9,
			reason: "still bad", now: "2026-07-23T00:05:00Z",
		}); // maxRounds 1 → escalates & halts again
		s.broker.control.resumeWorkflow({ workflowId: s.workflowId, now: "2026-07-23T00:06:00Z" });
		// same phase index → the second marker seeds again (stale-seed discard is covered by the next test)
		const again = kickoff(s);
		const text = requestTextOf(s, again.handoffId);
		expect(text).toContain("RESUMED PHASE"); // second resume seeded again — new marker, new seed
	});

	it("stale seed: marker for phase N is discarded when kicking off phase N+1 (plain kickoff)", () => {
		const s = resumeAndKickoff();
		// Simulate operator advancing the phase before kickoff fires.
		s.broker.db.prepare("UPDATE workflows SET current_phase_index = 1 WHERE workflow_id = ?").run(s.workflowId);
		const { handoffId } = s.broker.control.beginPhaseRun({
			workflowId: s.workflowId, phaseIndex: 1, phaseName: "plan-writing",
			initialHandoffStep: "implement", kickoffText: "Write the plan.",
			sender: "codex", target: "claude", maxRounds: 1, now: "2026-07-23T00:04:00Z",
		});
		const text = requestTextOf(s, handoffId);
		expect(text).toBe("Write the plan.");
		expect(readResumeSeedMarker(s.broker.control.getWorkflow(s.workflowId)!.workflowContext)).toBeNull();
	});

	it("rollback retains the seed: insertion failure AFTER marker consumption rolls back marker and all partial rows", () => {
		// The critical boundary (spec §2): the marker is read and cleared inside the
		// transaction BEFORE the chain/run/handoff inserts. Failing the guard is not
		// enough — force the LAST insert of the transaction to fail so a broken
		// implementation that clears resumeSeed non-transactionally would lose it.
		const s = resumeAndKickoff();
		const count = (table: string): number =>
			(s.broker.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
		const before = {
			chains: count("relay_chains"),
			runs: count("workflow_phases"),
			handoffs: count("relay_handoff"),
		};
		s.broker.db.exec(
			`CREATE TRIGGER abort_seed_kickoff BEFORE INSERT ON relay_handoff
			 BEGIN SELECT RAISE(ABORT, 'synthetic handoff insert failure'); END;`,
		);
		expect(() => kickoff(s)).toThrow(/synthetic handoff insert failure/);
		s.broker.db.exec("DROP TRIGGER abort_seed_kickoff;");
		// Marker retained; no partial chain/phase-run/handoff rows persisted.
		expect(readResumeSeedMarker(s.broker.control.getWorkflow(s.workflowId)!.workflowContext)).not.toBeNull();
		expect(count("relay_chains")).toBe(before.chains);
		expect(count("workflow_phases")).toBe(before.runs);
		expect(count("relay_handoff")).toBe(before.handoffs);
		// The retained seed still powers the next clean kickoff.
		const { handoffId } = kickoff(s, { now: "2026-07-23T00:05:00Z" });
		expect(requestTextOf(s, handoffId)).toContain("RESUMED PHASE");
	});

	it("guard failure (open phase run) also precedes consumption: seed survives", () => {
		const s = resumeAndKickoff();
		const first = kickoff(s); // opens a run and consumes the seed…
		// …then re-halt+re-resume for a fresh marker while that run is still open:
		// the next kickoff attempt throws at the guard, before marker consumption.
		s.broker.db.prepare("UPDATE workflows SET status = 'halted', halt_reason = 'synthetic' WHERE workflow_id = ?").run(s.workflowId);
		s.broker.control.resumeWorkflow({ workflowId: s.workflowId, now: "2026-07-23T00:07:00Z" });
		expect(() => kickoff(s)).toThrow(/open phase run already exists/);
		expect(readResumeSeedMarker(s.broker.control.getWorkflow(s.workflowId)!.workflowContext)).not.toBeNull();
		void first;
	});

	it("D1 immutability: seeded run gets a new chain; escalated chain and its handoffs are byte-identical", () => {
		const s = setupHaltedAtMaxRounds();
		const chainRowBefore = JSON.stringify(s.broker.db.prepare("SELECT * FROM relay_chains WHERE chain_id = ?").get(s.chainId));
		const handoffsBefore = JSON.stringify(s.broker.db.prepare("SELECT * FROM relay_handoff WHERE chain_id = ? ORDER BY handoff_id").all(s.chainId));
		broker_control_resume(s.broker, s.workflowId);
		const { chainId: newChainId } = kickoff(s);
		expect(newChainId).not.toBe(s.chainId);
		expect(JSON.stringify(s.broker.db.prepare("SELECT * FROM relay_chains WHERE chain_id = ?").get(s.chainId))).toBe(chainRowBefore);
		expect(JSON.stringify(s.broker.db.prepare("SELECT * FROM relay_handoff WHERE chain_id = ? ORDER BY handoff_id").all(s.chainId))).toBe(handoffsBefore);
	});

	it("no-chain halt: seeded kickoff carries the message; no handback/digest/commit-range sections", () => {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
		broker.control.startCollab({
			collabId: "collab_c1", workspaceRoot: "/tmp", displayName: "c1",
			orchestratorEnabled: true, orchestratorMaxRounds: 3, now: NOW,
		});
		broker.db
			.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status,
				   current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_nc', 'collab_c1', 'spec-driven-development', NULL, 'docs/spec.md',
				   '{"implementer":"claude","reviewer":"codex"}', 'halted', 0,
				   'implementer agent "claude" is not bound on collab collab_c1', '{}', ?, ?)`,
			)
			.run(NOW, NOW);
		broker.control.resumeWorkflow({ workflowId: "wf_nc", now: "2026-07-23T00:03:00Z", message: "bindings fixed, go" });
		const { handoffId } = broker.control.beginPhaseRun({
			workflowId: "wf_nc", phaseIndex: 0, phaseName: "spec-refining", initialHandoffStep: "review",
			kickoffText: "Review the spec.", sender: "claude", target: "codex", maxRounds: 1,
			now: "2026-07-23T00:04:00Z",
		});
		const text = (broker.db.prepare("SELECT request_text FROM relay_handoff WHERE handoff_id = ?").get(handoffId) as { request_text: string }).request_text;
		expect(text).toContain("bindings fixed, go");
		expect(text).toContain("not bound");
		expect(text).not.toContain("Final handback");
		expect(text).not.toContain("Prior rounds");
		expect(text).not.toContain("Commit range");
	});

	it("seedCommitBase renders the commit-range section; omitted → no section", () => {
		const withBase = resumeAndKickoff();
		const a = kickoff(withBase, { seedCommitBase: "abc1234" });
		expect(requestTextOf(withBase, a.handoffId)).toContain("abc1234..HEAD");
		const noBase = resumeAndKickoff();
		const b = kickoff(noBase);
		expect(requestTextOf(noBase, b.handoffId)).not.toContain("Commit range");
	});
});

describe("D3 — fresh round budget on the seeded chain", () => {
	it("seeded chain escalates again at the configured max rounds", () => {
		const s = setupHaltedAtMaxRounds();
		s.broker.control.resumeWorkflow({ workflowId: s.workflowId, now: "2026-07-23T00:03:00Z" });
		const { handoffId, chainId } = s.broker.control.beginPhaseRun({
			workflowId: s.workflowId, phaseIndex: 0, phaseName: "spec-refining",
			initialHandoffStep: "review", kickoffText: "Review the spec.",
			sender: "claude", target: "codex", maxRounds: 1, now: "2026-07-23T00:04:00Z",
		});
		const chain = s.broker.control.getRelayChain(chainId);
		expect(chain?.currentRound).toBe(1); // fresh chain starts at round 1
		expect(chain?.maxRounds).toBe(1);    // configured budget, unchanged
		s.broker.control.applyOrchestratorVerdict({
			handoffId, verdict: "findings", confidence: 0.9, reason: "still failing",
			now: "2026-07-23T00:05:00Z",
		});
		const wf = s.broker.control.getWorkflow(s.workflowId);
		expect(wf?.status).toBe("halted");
		expect(wf?.haltReason).toBe("max-rounds-reached (1/1)"); // full budget honored, then re-escalated
	});
});
