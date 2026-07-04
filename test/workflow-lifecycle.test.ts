import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { listWorkflowEventsAfter } from "../packages/broker/src/storage/repositories/workflow-event-outbox-repository.ts";

function setup(workspaceRoot = "/tmp") {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	broker.control.startCollab({
		collabId: "collab_c1",
		workspaceRoot,
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
	const { workflowId } = broker.control.createWorkflow({
		collabId: "collab_c1",
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now: "2026-04-21T00:00:00Z",
	});
	return { broker, workflowId };
}

// Track temp git dirs created for snapshot tests so they can be cleaned up.
const tempGitDirs: string[] = [];

/** A broker whose collab workspace root is a real temp git repo, so the
 *  synchronous snapshot capture returns a real commit SHA (non-null). */
function setupWithGitWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-wf-git-"));
	tempGitDirs.push(dir);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(dir, "spec.md"), "v1\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	return { ...setup(dir), dir };
}

/** Flip a workflow to a terminal status the public control API can't reach. */
function forceStatus(
	broker: ReturnType<typeof createBrokerRuntime>,
	workflowId: string,
	status: string,
	now: string,
) {
	broker.db
		.prepare("UPDATE workflows SET status = ?, updated_at = ? WHERE workflow_id = ?")
		.run(status, now, workflowId);
}

afterEach(() => {
	while (tempGitDirs.length) {
		rmSync(tempGitDirs.pop()!, { recursive: true, force: true });
	}
});

/** Persisted workflow.done rows in the event outbox — the "recorded" half of
 *  markWorkflowDone's emit-iff-transition contract. */
function recordedDoneEvents(broker: ReturnType<typeof createBrokerRuntime>) {
	return listWorkflowEventsAfter(broker.db, { collabId: "collab_c1", afterId: 0 }).filter(
		(r) => r.eventName === "workflow.done",
	);
}

// helper for tests that need an active phase run
function setupWithPhase() {
	const { broker, workflowId } = setup();
	const { handoffId, chainId } = broker.control.beginPhaseRun({
		workflowId,
		phaseIndex: 0,
		phaseName: "spec-refining",
		initialHandoffStep: "review",
		kickoffText: "Review the spec at docs/spec.md.",
		sender: "claude",
		target: "codex",
		maxRounds: 3,
		now: "2026-04-21T00:01:00Z",
	});
	return { broker, workflowId, handoffId, chainId };
}

describe("workflow lifecycle (halt/resume/cancel)", () => {
	it("haltWorkflow transitions running → halted and emits workflow.halted", () => {
		const { broker, workflowId } = setup();
		const halted: unknown[] = [];
		broker.events.on("workflow.halted", (e) => halted.push(e));
		broker.control.haltWorkflow({
			workflowId,
			reason: "target agent missing",
			now: "2026-04-21T00:05:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
		expect(halted).toEqual([{ workflowId, reason: "target agent missing" }]);
	});

	it("resumeWorkflow rejects canceled status", () => {
		const { broker, workflowId } = setup();
		broker.control.cancelWorkflow({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		expect(() =>
			broker.control.resumeWorkflow({
				workflowId,
				now: "2026-04-21T00:06:00Z",
			}),
		).toThrow(/canceled/);
	});

	it("resumeWorkflow rejects when another workflow is already running", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "stuck",
			now: "2026-04-21T00:05:00Z",
		});
		// Start a second, now-running workflow
		broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec2.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:06:00Z",
		});
		expect(() =>
			broker.control.resumeWorkflow({
				workflowId,
				now: "2026-04-21T00:07:00Z",
			}),
		).toThrow(/already (running|active)/);
	});

	it("pauseWorkflow transitions running → paused, sets pausedAt, emits workflow.paused", () => {
		const { broker, workflowId } = setup();
		const paused: unknown[] = [];
		broker.events.on("workflow.paused", (e) => paused.push(e));
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("paused");
		expect(wf.workflowContext.pausedAt).toBe("2026-05-27T00:02:00Z");
		expect(paused).toEqual([{ workflowId }]);
	});

	it("pauseWorkflow with no in-flight accepted handoff captures pauseSnapshotRef SYNCHRONOUSLY before returning", () => {
		const { broker, workflowId } = setup(); // workspaceRoot /tmp is not a git repo → ref null but KEY present
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		// No await, no tick: the snapshot must already be persisted the instant pause returns.
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(Object.prototype.hasOwnProperty.call(wf.workflowContext, "pauseSnapshotRef")).toBe(true);
	});

	it("pause-then-immediate-resume on an already-quiesced workflow has a non-racing baseline", () => {
		const { broker, workflowId } = setupWithGitWorkspace(); // real git repo → real SHA
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		const ref = (
			broker.control.getWorkflow(workflowId)!.workflowContext as { pauseSnapshotRef?: string | null }
		).pauseSnapshotRef;
		expect(ref).toMatch(/^[0-9a-f]{7,40}$/); // captured, non-null, with zero awaits
	});

	// Spec §"Error handling": pause on done / canceled / halted / already-paused must
	// reject with a clear message AND make NO state change.
	it("pauseWorkflow rejects a halted workflow and leaves it halted", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({ workflowId, reason: "escalated", now: "2026-05-27T00:01:00Z" });
		expect(() => broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" }))
			.toThrow(/only running workflows can be paused/);
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("halted");
		expect(Object.prototype.hasOwnProperty.call(wf.workflowContext, "pausedAt")).toBe(false);
	});

	it("pauseWorkflow rejects a canceled workflow and leaves it canceled", () => {
		const { broker, workflowId } = setup();
		broker.control.cancelWorkflow({ workflowId, now: "2026-05-27T00:01:00Z" });
		expect(() => broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" }))
			.toThrow(/only running workflows can be paused/);
		expect(broker.control.getWorkflow(workflowId)!.status).toBe("canceled");
	});

	it("pauseWorkflow rejects a done workflow and leaves it done", () => {
		const { broker, workflowId } = setup();
		forceStatus(broker, workflowId, "done", "2026-05-27T00:01:00Z");
		expect(() => broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" }))
			.toThrow(/only running workflows can be paused/);
		expect(broker.control.getWorkflow(workflowId)!.status).toBe("done");
	});

	it("pauseWorkflow rejects an already-paused workflow and does not re-stamp pausedAt", () => {
		const { broker, workflowId } = setup();
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		const firstPausedAt = broker.control.getWorkflow(workflowId)!.workflowContext.pausedAt;
		expect(() => broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:03:00Z" }))
			.toThrow(/is paused, only running workflows can be paused/);
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("paused");
		expect(wf.workflowContext.pausedAt).toBe(firstPausedAt);
	});

	it("pause during an in-flight turn defers the snapshot; recording the handback reaches the boundary and captures it", () => {
		const { broker, workflowId, handoffId } = setupWithPhase();
		// Accept the handoff → an agent is mid-turn (status 'accepted').
		broker.control.acceptRelayHandoff({ handoffId, acceptedAt: "2026-05-27T00:01:30Z" });
		// Pause while in flight: snapshot must NOT be captured yet (no quiesce boundary).
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		expect(
			Object.prototype.hasOwnProperty.call(
				broker.control.getWorkflow(workflowId)!.workflowContext,
				"pauseSnapshotRef",
			),
		).toBe(false);
		// The in-flight handback must still be RECORDED (not refused) even while paused.
		broker.control.handoffBackRelay({
			handoffId,
			nextHandoffId: "ho_next_x",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "done with the turn",
			now: "2026-05-27T00:03:00Z",
		});
		expect(broker.control.getRelayHandoff(handoffId)!.status).toBe("handed_back");
		// Boundary reached → snapshot key now present (ref null under /tmp, but evaluated).
		expect(
			Object.prototype.hasOwnProperty.call(
				broker.control.getWorkflow(workflowId)!.workflowContext,
				"pauseSnapshotRef",
			),
		).toBe(true);
	});

	it("createWorkflow rejects a second workflow while the first is paused (active-set guard)", () => {
		const { broker, workflowId } = setup();
		// Flip the existing workflow to paused directly (pauseWorkflow lands in a later task);
		// the active-set guard must still count it as occupying the collab slot.
		broker.db
			.prepare("UPDATE workflows SET status = 'paused' WHERE workflow_id = ?")
			.run(workflowId);
		expect(() =>
			broker.control.createWorkflow({
				collabId: "collab_c1",
				workflowType: "spec-driven-development",
				specPath: "docs/spec2.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-05-27T00:03:00Z",
			}),
		).toThrow(/already active/);
	});

	it("resume paused diffs the real workspace against pauseSnapshotRef and stores a changed-files notice", () => {
		const { broker, workflowId, dir } = setupWithGitWorkspace();
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		// real SHA baseline captured synchronously:
		expect(
			(broker.control.getWorkflow(workflowId)!.workflowContext as { pauseSnapshotRef?: string })
				.pauseSnapshotRef,
		).toMatch(/^[0-9a-f]{7,40}$/);
		// operator edits a tracked file during the pause:
		writeFileSync(join(dir, "spec.md"), "v2 — corrected\n");
		broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:06:00Z" });
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("running");
		expect(wf.workflowContext.resumeNotice).toContain("While paused, the operator modified these files:");
		expect(wf.workflowContext.resumeNotice).toContain("- spec.md");
		// baseline cleared on resume so a later pause starts fresh:
		expect(wf.workflowContext.pauseSnapshotRef ?? null).toBeNull();
	});

	it("resume paused merges changed files AND the operator message into one notice", () => {
		const { broker, workflowId, dir } = setupWithGitWorkspace();
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		writeFileSync(join(dir, "spec.md"), "v2\n");
		broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:06:00Z", message: "see spec" });
		const notice = broker.control.getWorkflow(workflowId)!.workflowContext.resumeNotice as string;
		expect(notice).toContain("- spec.md");
		expect(notice).toContain("Operator note: see spec");
	});

	it("resume paused → running stores a message-only notice when snapshot was unavailable", () => {
		const { broker, workflowId } = setup(); // /tmp is not a git repo → pauseSnapshotRef null
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		expect(broker.control.getWorkflow(workflowId)!.workflowContext.pauseSnapshotRef).toBeNull();
		broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:06:00Z", message: "re-read the spec" });
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("running");
		expect(wf.workflowContext.resumeNotice).toContain("Operator note: re-read the spec");
		expect(wf.workflowContext.resumeNotice).not.toContain("modified these files");
	});

	it("resume paused with no changes and no message does a plain resume (no notice)", () => {
		const { broker, workflowId } = setupWithGitWorkspace(); // git repo, but operator changes nothing
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:06:00Z" });
		const wf = broker.control.getWorkflow(workflowId)!;
		expect(wf.status).toBe("running");
		expect(wf.workflowContext.resumeNotice ?? null).toBeNull();
	});

	it("resume rejects a running workflow", () => {
		const { broker, workflowId } = setup();
		expect(() => broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:06:00Z" }))
			.toThrow(/is running, only paused or halted workflows can be resumed/);
		expect(broker.control.getWorkflow(workflowId)!.status).toBe("running");
	});

	it("resume rejects a done workflow", () => {
		const { broker, workflowId } = setup();
		forceStatus(broker, workflowId, "done", "2026-05-27T00:01:00Z");
		expect(() => broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:06:00Z" }))
			.toThrow(/is done, only paused or halted workflows can be resumed/);
		expect(broker.control.getWorkflow(workflowId)!.status).toBe("done");
	});

	it("resume notice is prepended to the next orchestrator-created handoff exactly once, then cleared", () => {
		const { broker, workflowId, handoffId } = setupWithPhase();
		broker.control.acceptRelayHandoff({ handoffId, acceptedAt: "2026-05-27T00:01:30Z" });
		broker.control.handoffBackRelay({
			handoffId,
			nextHandoffId: "ho_hb",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "reviewed",
			now: "2026-05-27T00:02:00Z",
		});
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:30Z" });
		broker.control.resumeWorkflow({
			workflowId,
			now: "2026-05-27T00:03:00Z",
			message: "re-read spec.md",
		});
		expect(broker.control.getWorkflow(workflowId)!.workflowContext.resumeNotice).toContain(
			"Operator note: re-read spec.md",
		);

		// The orchestrator now evaluates the deferred handback and creates the next
		// (fix) handoff — the real delivery surface. Its request text must carry the notice.
		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "findings",
			confidence: 1,
			reason: "address these",
			followUpMessage: "fix the thing",
			now: "2026-05-27T00:03:30Z",
		});
		const next = broker.control.getRelayHandoff(result.nextHandoffId!)!;
		expect(next.requestText).toContain("Operator note: re-read spec.md");
		expect(next.requestText).toContain("fix the thing"); // original request preserved after the notice

		// Consumed once → cleared; a second consume yields null.
		expect(broker.control.getWorkflow(workflowId)!.workflowContext.resumeNotice ?? null).toBeNull();
		expect(
			broker.control.consumeResumeNotice({ workflowId, now: "2026-05-27T00:04:00Z" }),
		).toBeNull();
	});

	it("resume bakes the notice into a handoff already pending accept (consumed, not left on context)", () => {
		const { broker, workflowId, handoffId } = setupWithPhase(); // initial handoff is 'pending'
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		broker.control.resumeWorkflow({
			workflowId,
			now: "2026-05-27T00:03:00Z",
			message: "re-read spec.md",
		});
		// The pending request the mount will inject raw must already carry the notice.
		const pending = broker.control.getRelayHandoff(handoffId)!;
		expect(pending.status).toBe("pending");
		expect(pending.requestText).toContain("Operator note: re-read spec.md");
		expect(pending.requestText).toContain("Review the spec at docs/spec.md."); // original preserved after notice
		// Consumed into the pending handoff → NOT left on the context (no double-delivery).
		expect(broker.control.getWorkflow(workflowId)!.workflowContext.resumeNotice ?? null).toBeNull();
	});

	it("resume releases a handback the orchestrator claimed-but-could-not-evaluate while paused", () => {
		const { broker, workflowId, handoffId } = setupWithPhase();
		broker.control.acceptRelayHandoff({ handoffId, acceptedAt: "2026-05-27T00:01:00Z" });
		broker.control.handoffBackRelay({
			handoffId,
			nextHandoffId: "ho_hb2",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "reviewed",
			now: "2026-05-27T00:01:30Z",
		});
		// Orchestrator claims it (workflow still running) → orchestrator_status='pending'.
		expect(
			broker.control.claimRelayHandoffForOrchestration({ handoffId, claimedAt: "2026-05-27T00:01:45Z" }),
		).not.toBeNull();
		// Pause lands before the verdict is applied.
		broker.control.pauseWorkflow({ workflowId, now: "2026-05-27T00:02:00Z" });
		// Applying the verdict while paused throws (workflow not running) → handoff stranded.
		expect(() =>
			broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "findings",
				confidence: 1,
				reason: "x",
				now: "2026-05-27T00:02:30Z",
			}),
		).toThrow();
		// While paused it is excluded from the pending list (delivery suspended).
		expect(
			broker.control.listRelayHandoffsPendingOrchestration("collab_c1").map((h) => h.handoffId),
		).not.toContain(handoffId);
		// Resume releases the stranded claim back to idle so the orchestrator re-lists it.
		broker.control.resumeWorkflow({ workflowId, now: "2026-05-27T00:03:00Z" });
		expect(
			broker.control.listRelayHandoffsPendingOrchestration("collab_c1").map((h) => h.handoffId),
		).toContain(handoffId);
	});

	it("resumeWorkflow flips halted → running and emits workflow.resumed", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "stuck",
			now: "2026-04-21T00:05:00Z",
		});
		const resumed: unknown[] = [];
		broker.events.on("workflow.resumed", (e) => resumed.push(e));
		broker.control.resumeWorkflow({
			workflowId,
			now: "2026-04-21T00:06:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("running");
		expect(resumed).toEqual([{ workflowId, phaseIndex: 0 }]);
	});

	it("cancelWorkflow sets status=canceled, closes open phase run, abandons chain, and emits workflow.canceled", () => {
		const { broker, workflowId, chainId } = setupWithPhase();
		const phaseRuns = broker.control.getWorkflowPhaseRuns(workflowId);
		const openRun = phaseRuns.find((r) => r.endedAt === null);
		expect(openRun).toBeDefined();
		const canceled: unknown[] = [];
		broker.events.on("workflow.canceled", (e) => canceled.push(e));
		broker.control.cancelWorkflow({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("canceled");
		const after = broker.control.getWorkflowPhaseRuns(workflowId).find((r) => r.phaseRunId === openRun!.phaseRunId);
		expect(after?.endedAt).toBe("2026-04-21T00:05:00Z");
		expect(after?.outcome).toBe("superseded");
		expect(broker.control.getRelayChain(chainId)?.status).toBe("abandoned");
		expect(canceled).toEqual([
			{ workflowId, reason: "canceled by operator" },
		]);
		// Turn state must idle so mount panes stop advertising the abandoned handoff.
		const turnState = broker.control.getRelayTurnState("collab_c1");
		expect(turnState?.unresolvedHandoffId).toBeNull();
		expect(turnState?.turnOwner).toBe("none");
		expect(turnState?.waitingAgent).toBeNull();
		expect(turnState?.handoffState).toBe("idle");
		expect(turnState?.chainStatus).toBe("abandoned");
	});

	it("haltWorkflow throws when workflow not found", () => {
		const { broker } = setup();
		expect(() =>
			broker.control.haltWorkflow({
				workflowId: "wf_nonexistent",
				reason: "gone",
				now: "2026-04-21T00:05:00Z",
			}),
		).toThrow();
	});

	it("haltWorkflow throws when workflow already halted", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "first halt",
			now: "2026-04-21T00:05:00Z",
		});
		expect(() =>
			broker.control.haltWorkflow({
				workflowId,
				reason: "second halt",
				now: "2026-04-21T00:06:00Z",
			}),
		).toThrow();
	});
});

describe("markWorkflowDone (operator completes an escalated run)", () => {
	it("throws on unknown workflowId, emits nothing, records nothing", () => {
		const { broker } = setup();
		const done: unknown[] = [];
		broker.events.on("workflow.done", (e) => done.push(e));
		expect(() =>
			broker.control.markWorkflowDone({
				workflowId: "wf_nonexistent",
				now: "2026-04-21T00:05:00Z",
			}),
		).toThrow("markWorkflowDone: unknown workflowId wf_nonexistent");
		expect(done).toEqual([]);
		expect(recordedDoneEvents(broker)).toEqual([]);
	});

	it.each(["running", "paused", "done", "canceled"] as const)(
		"throws for %s status, writes nothing, emits nothing, records nothing",
		(status) => {
			const { broker, workflowId } = setup();
			forceStatus(broker, workflowId, status, "2026-04-21T00:04:00Z");
			const done: unknown[] = [];
			broker.events.on("workflow.done", (e) => done.push(e));
			expect(() =>
				broker.control.markWorkflowDone({
					workflowId,
					now: "2026-04-21T00:05:00Z",
				}),
			).toThrow(
				`markWorkflowDone: workflow ${workflowId} is ${status}, only halted (escalated) workflows can be marked done`,
			);
			expect(broker.control.getWorkflow(workflowId)?.status).toBe(status);
			expect(done).toEqual([]);
			expect(recordedDoneEvents(broker)).toEqual([]);
		},
	);

	it("halted (no open phase runs) → done with operator halt reason, emits and records workflow.done once", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "escalated: env blocker",
			now: "2026-04-21T00:04:00Z",
		});
		const done: unknown[] = [];
		broker.events.on("workflow.done", (e) => done.push(e));
		broker.control.markWorkflowDone({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		const wf = broker.control.getWorkflow(workflowId);
		expect(wf?.status).toBe("done");
		expect(wf?.haltReason).toBe("marked done by operator");
		expect(done).toEqual([{ workflowId }]);
		const recorded = recordedDoneEvents(broker);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.payload).toEqual({ workflowId });
	});

	it("bare-halt with an open phase run → run closed superseded, chain abandoned with operator reason, turn state idles with chainStatus done", () => {
		const { broker, workflowId, chainId } = setupWithPhase();
		broker.control.haltWorkflow({
			workflowId,
			reason: "No handback text captured",
			now: "2026-04-21T00:04:00Z",
		});
		const openRun = broker.control
			.getWorkflowPhaseRuns(workflowId)
			.find((r) => r.endedAt === null);
		expect(openRun).toBeDefined(); // bare haltWorkflow leaves the run open
		broker.control.markWorkflowDone({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("done");
		const after = broker.control
			.getWorkflowPhaseRuns(workflowId)
			.find((r) => r.phaseRunId === openRun!.phaseRunId);
		expect(after?.endedAt).toBe("2026-04-21T00:05:00Z");
		expect(after?.outcome).toBe("superseded");
		const chain = broker.control.getRelayChain(chainId);
		expect(chain?.status).toBe("abandoned");
		expect(chain?.terminalReason).toBe("marked done by operator");
		const turnState = broker.control.getRelayTurnState("collab_c1");
		expect(turnState?.unresolvedHandoffId).toBeNull();
		expect(turnState?.turnOwner).toBe("none");
		expect(turnState?.waitingAgent).toBeNull();
		expect(turnState?.handoffState).toBe("idle");
		expect(turnState?.chainStatus).toBe("done");
	});

	it("a chain already terminal (escalated) is left untouched — only open runs are swept", () => {
		const { broker, workflowId, chainId } = setupWithPhase();
		// Simulate the escalation-verdict path having closed everything:
		const now = "2026-04-21T00:03:00Z";
		broker.db
			.prepare(
				"UPDATE workflow_phases SET ended_at = ?, outcome = 'escalated' WHERE workflow_id = ?",
			)
			.run(now, workflowId);
		broker.db
			.prepare("UPDATE relay_chains SET status = 'escalated' WHERE chain_id = ?")
			.run(chainId);
		forceStatus(broker, workflowId, "halted", now);
		broker.control.markWorkflowDone({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("done");
		expect(broker.control.getRelayChain(chainId)?.status).toBe("escalated");
	});

	it("double mark-done: second call throws (now done), emits nothing more, records nothing more", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "escalated",
			now: "2026-04-21T00:04:00Z",
		});
		const done: unknown[] = [];
		broker.events.on("workflow.done", (e) => done.push(e));
		broker.control.markWorkflowDone({ workflowId, now: "2026-04-21T00:05:00Z" });
		expect(() =>
			broker.control.markWorkflowDone({ workflowId, now: "2026-04-21T00:06:00Z" }),
		).toThrow(
			`markWorkflowDone: workflow ${workflowId} is done, only halted (escalated) workflows can be marked done`,
		);
		expect(done).toEqual([{ workflowId }]);
		expect(recordedDoneEvents(broker)).toHaveLength(1);
	});
});
