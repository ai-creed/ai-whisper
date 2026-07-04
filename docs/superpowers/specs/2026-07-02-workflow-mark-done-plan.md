# Workflow Mark-Done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the human operator mark a halted (escalated) workflow as done — from the dashboard (`d` key) or CLI (`whisper workflow complete <id>`) — for runs whose work is complete but whose verification was environment-blocked.

**Architecture:** One new broker control method `markWorkflowDone` (atomic guard-and-transition inside a single immediate sqlite transaction, `workflow.done` emitted iff the transition committed), exposed automatically through the control-service merge; the dashboard gains a `done` action on halted cards reusing the existing confirm modal; the CLI gains a `complete` command mirroring pause/resume/cancel.

**Tech Stack:** TypeScript (pnpm monorepo), better-sqlite3, ink (dashboard), commander (CLI), vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-workflow-mark-done-design.md` (revision 2026-07-03a)

## Global Constraints

- Indentation is TABS in all TypeScript files (repo convention).
- Tests live in the root `test/` directory, run with vitest.
- `pnpm lint` is eslint only — NEVER run `prettier --write` on pre-existing files.
- Full verification gate: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.
- Broker guard messages must be exactly: `markWorkflowDone: unknown workflowId <id>` and `markWorkflowDone: workflow <id> is <status>, only halted (escalated) workflows can be marked done`.
- Audit reason string is exactly `"marked done by operator"` — used for `halt_reason` AND the chain `terminalReason`.
- Eligibility: `halted` status ONLY. `running`, `paused`, `done`, `canceled`, unknown → throw, write nothing, emit nothing.
- `workflow.done` is emitted iff the `halted → done` transition committed (atomic-guard contract; do NOT copy `cancelWorkflow`'s guard-outside/re-check-inside shape).
- Only operator mark-done writes `workflow.done` outbox rows — the driver's natural completion path must remain un-outboxed (it emits in-daemon via `pendingEmissions`), preserving exactly-once socket delivery.
- Turn-state reset uses `chainStatus: "done"` (natural-completion parity), NOT cancel's `"abandoned"`.
- `packages/cli/README.md` is build-generated from the root `README.md` — only ever edit the root README.

---

### Task 1: Broker control method `markWorkflowDone`

**Files:**
- Modify: `packages/broker/src/storage/repositories/workflow-event-outbox-repository.ts:1-11` (add `"workflow.done"` to `WorkflowOutboxEventName`, update the header comment)
- Modify: `packages/broker/src/runtime/workflow-event-bridge.ts` (comment-only accuracy updates — no behavior change)
- Modify: `packages/broker/src/control/workflow-control.ts` (new method after `cancelWorkflow` ~line 1515, plus return-object entry ~line 1561)
- Test: `test/workflow-lifecycle.test.ts` (new describe block at end of file)
- Test: `test/workflow-event-bridge.test.ts` (one new re-emit test)

**Interfaces:**
- Consumes: existing helpers already imported in workflow-control.ts — `getWorkflowById`, `listPhaseRunsForWorkflow`, `closeWorkflowPhaseRun`, `setChainTerminal`, `getRelayChainRepo`, `setWorkflowStatus`, `upsertRelayTurnState`, `emitAndRecord` (all used by `cancelWorkflow`, same file).
- Produces: `markWorkflowDone(input: { workflowId: string; now: string }): void` on the `createWorkflowControl` return object. The control service (`create-control-service.ts:1529`) merges that object into its return, so `broker.control.markWorkflowDone` exists with NO further wiring — Tasks 2 and 3 rely on exactly this name and signature.
- Produces: `WorkflowOutboxEventName` gains `"workflow.done"`. This is REQUIRED for typechecking: `emitAndRecord` is generic over `WorkflowOutboxEventName` (`workflow-control.ts:161-168`) and the current union (`workflow-event-outbox-repository.ts:7-11`) excludes `workflow.done`. The payload type needs no change — `BrokerEventMap` already types `"workflow.done": { workflowId: string }` (`broker-event-bus.ts:38`).

**Why outboxing `workflow.done` here is architecturally correct (not a workaround):** the outbox exists to carry CLI-originated operator lifecycle events (created/paused/resumed/canceled) from the transient CLI-side `BrokerRuntime` into the daemon, whose bridge re-emits rows verbatim on a dedicated socket-only bus (`workflow-event-bridge.ts` — no per-name switch, so no bridge code change). `markWorkflowDone` is exactly that class of event source: `whisper workflow complete` and the dashboard both run on transient runtimes via `connectToWorkspaceBroker`. Exactly-once delivery is preserved because the driver's NATURAL completion path does not use `emitAndRecord` — it emits `workflow.done` in-daemon via its `pendingEmissions` drain (`workflow-control.ts:~1162,1196-1200`) and never writes an outbox row. Only operator mark-done writes a `workflow.done` outbox row. The `workflow_event_outbox` table has no CHECK constraint on `event_name` (plain TEXT, `apply-migrations.ts:354-360`), so NO migration is needed.

- [ ] **Step 1: Write the failing tests**

Append this describe block to `test/workflow-lifecycle.test.ts` (it reuses the file's existing `setup`, `setupWithPhase`, and `forceStatus` helpers — do not redefine them). The emit-iff-transition contract has TWO halves: the in-memory bus emission (`broker.events`) AND the persisted event-log record (`emitAndRecord` → `appendWorkflowEvent` → the `workflow_event_outbox` table). Every test asserts both. Add this import at the top of the file, beside the existing imports:

```ts
import { listWorkflowEventsAfter } from "../packages/broker/src/storage/repositories/workflow-event-outbox-repository.ts";
```

(Reading the outbox directly via `broker.db` is the established pattern — `test/workflow-event-bridge.test.ts:180` does exactly this. Note: `broker.control.listEventsForCollab` reads the separate `event_log` table, NOT the outbox `emitAndRecord` writes to — do not use it here.)

And add this helper beside `forceStatus`:

```ts
/** Persisted workflow.done rows in the event outbox — the "recorded" half of
 *  markWorkflowDone's emit-iff-transition contract. */
function recordedDoneEvents(broker: ReturnType<typeof createBrokerRuntime>) {
	return listWorkflowEventsAfter(broker.db, { collabId: "collab_c1", afterId: 0 }).filter(
		(r) => r.eventName === "workflow.done",
	);
}
```

```ts
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
```

Table/column names in the already-terminal test are verified against `packages/broker/src/storage/apply-migrations.ts`: `workflow_phases(phase_run_id, workflow_id, chain_id, ended_at, outcome, …)` and `relay_chains(chain_id, status, terminal_reason, …)`. `getRelayChain` returns `terminalReason` (mapped from `terminal_reason` in `relay-chain-repository.ts`).

Also append this test to the describe in `test/workflow-event-bridge.test.ts` (after the "delivers BOTH frames…" test ~line 99; it reuses the file's `freshDb`/`append`/`collect` helpers and existing imports) — it proves an operator mark-done row reaches the daemon's socket bus:

```ts
	it("delivers an operator mark-done workflow.done row verbatim", () => {
		const db = freshDb();
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed empty
		append(db, "workflow.done", { workflowId: "wf_a" });
		bridge.tick();
		expect(seen).toEqual([{ name: "workflow.done", payload: { workflowId: "wf_a" } }]);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/workflow-lifecycle.test.ts test/workflow-event-bridge.test.ts`
Expected: the new lifecycle describe block FAILS with `broker.control.markWorkflowDone is not a function`; the new bridge test FAILS to compile — `"workflow.done"` is not assignable to `WorkflowOutboxEventName` (the `append` helper is typed with that union). All pre-existing tests still pass.

- [ ] **Step 3a: Extend the outbox event-name contract**

In `packages/broker/src/storage/repositories/workflow-event-outbox-repository.ts`, replace the header comment and union (lines 3-11) with:

```ts
// The event names the outbox carries: the CLI-originated workflow lifecycle
// events that run on a transient BrokerRuntime and so never reach the daemon's
// in-process bus. Driver-native events (phase/round/halted, and the driver's
// own natural workflow.done) are emitted in the daemon and are NOT outboxed.
// "workflow.done" appears here ONLY for operator mark-done (markWorkflowDone),
// which runs CLI-side like pause/resume/cancel; the natural completion path
// never writes an outbox row, so the socket still sees each event exactly once.
export type WorkflowOutboxEventName =
	| "workflow.created"
	| "workflow.paused"
	| "workflow.resumed"
	| "workflow.canceled"
	| "workflow.done";
```

In `packages/broker/src/runtime/workflow-event-bridge.ts`, two comment-only updates so the docs stay true (no behavior change — the bridge re-emits rows verbatim with no per-name switch):

1. In the header comment, replace its final sentence — `Driver-native events (phase/round/halted/done) are never outboxed, so the socket sees each event exactly once.` (~lines 33-34) — with:

```
// as-is. Driver-native events (phase/round/halted, and the driver's own
// natural workflow.done) are never outboxed; workflow.done is outboxed ONLY
// by operator mark-done, so the socket sees each event exactly once.
```

2. In the tick-loop comment (~line 59), replace `The outbox holds only the four CLI-originated lifecycle events, each` with `The outbox holds only CLI-originated lifecycle events, each`.

- [ ] **Step 3b: Implement `markWorkflowDone`**

In `packages/broker/src/control/workflow-control.ts`, insert after the closing brace of `cancelWorkflow` (~line 1515):

```ts
	function markWorkflowDone(input: { workflowId: string; now: string }): void {
		// Eligibility guard and transition run atomically inside ONE immediate
		// transaction: the emit below is reached iff the halted → done transition
		// committed. A raced status change makes the guard throw (rolling back)
		// instead of letting a no-op transaction emit a false completion event —
		// deliberate deviation from cancelWorkflow's guard-outside shape.
		const tx = db.transaction(() => {
			const workflow = getWorkflowById(db, input.workflowId);
			if (!workflow) {
				throw new Error(`markWorkflowDone: unknown workflowId ${input.workflowId}`);
			}
			if (workflow.status !== "halted") {
				throw new Error(
					`markWorkflowDone: workflow ${input.workflowId} is ${workflow.status}, only halted (escalated) workflows can be marked done`,
				);
			}

			// Close any phase runs the halt left open. The escalation-verdict path
			// already closed everything; a bare haltWorkflow only flips status.
			const openPhaseRuns = listPhaseRunsForWorkflow(db, input.workflowId).filter(
				(r) => r.endedAt === null,
			);
			let lastChainRecord: RelayChainRecord | undefined;
			for (const run of openPhaseRuns) {
				const latest = db
					.prepare(
						`SELECT handoff_id FROM relay_handoff
						 WHERE chain_id = ?
						 ORDER BY created_at DESC LIMIT 1`,
					)
					.get(run.chainId) as { handoff_id: string } | undefined;

				const chainRecord = getRelayChainRepo(db, run.chainId) ?? undefined;
				lastChainRecord = chainRecord;

				closeWorkflowPhaseRun(db, {
					phaseRunId: run.phaseRunId,
					outcome: "superseded",
					now: input.now,
				});

				setChainTerminal(db, {
					chainId: run.chainId,
					status: "abandoned",
					terminalHandoffId: latest?.handoff_id ?? null,
					terminalReason: "marked done by operator",
					now: input.now,
				});
			}

			setWorkflowStatus(db, {
				workflowId: input.workflowId,
				status: "done",
				haltReason: "marked done by operator",
				now: input.now,
			});

			const collabRow = db
				.prepare("SELECT orchestrator_max_rounds FROM collab WHERE collab_id = ?")
				.get(workflow.collabId) as { orchestrator_max_rounds: number } | undefined;

			// chainStatus "done", matching natural completion — the run concluded
			// successfully from the operator's perspective (not cancel's "abandoned").
			upsertRelayTurnState(db, {
				collabId: workflow.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
				orchestratorEnabled: true,
				currentRound: lastChainRecord?.currentRound ?? 1,
				maxRounds: lastChainRecord?.maxRounds ?? collabRow?.orchestrator_max_rounds ?? 3,
				chainStatus: "done",
			});

			return workflow.collabId;
		});
		const collabId = tx.immediate() as string;

		emitAndRecord(collabId, "workflow.done", { workflowId: input.workflowId }, input.now);
	}
```

All helpers (`getWorkflowById`, `listPhaseRunsForWorkflow`, `closeWorkflowPhaseRun`, `setChainTerminal`, `getRelayChainRepo`, `setWorkflowStatus`, `upsertRelayTurnState`, `RelayChainRecord`) are already imported at the top of the file — `cancelWorkflow` uses every one of them. Add nothing to the imports unless tsc says otherwise.

Then add `markWorkflowDone,` to the return object (~line 1561), directly after `cancelWorkflow,`:

```ts
	return {
		createWorkflow,
		getWorkflow,
		listWorkflows,
		getWorkflowPhaseRuns,
		getRelayChain,
		beginPhaseRun,
		applyOrchestratorVerdict,
		haltWorkflow,
		pauseWorkflow,
		maybeCaptureQuiesceSnapshot,
		consumeResumeNotice,
		resumeWorkflow,
		cancelWorkflow,
		markWorkflowDone,
		getHandoffWithWorkflowMeta,
		getLatestHandoffForPhaseRun,
	};
```

No control-service change is needed: `create-control-service.ts` line 1529 merges the whole `workflowControl` object into `broker.control`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/workflow-lifecycle.test.ts test/workflow-event-bridge.test.ts`
Expected: all tests PASS, including the 6 new lifecycle tests and the new bridge re-emit test.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: exit 0 (fails without Step 3a — `emitAndRecord` is bounded by `WorkflowOutboxEventName`).

```bash
git add packages/broker/src/control/workflow-control.ts packages/broker/src/storage/repositories/workflow-event-outbox-repository.ts packages/broker/src/runtime/workflow-event-bridge.ts test/workflow-lifecycle.test.ts test/workflow-event-bridge.test.ts
git commit -m "feat(broker): add markWorkflowDone control method

Operator marks a halted (escalated) workflow as done after manual
verification. Guard and transition are atomic in one immediate
transaction; workflow.done is emitted iff the halted->done transition
committed. Sweeps phase runs a bare haltWorkflow left open; turn state
resets with chainStatus done (natural-completion parity).

The outbox event-name union gains workflow.done so the CLI-side
mark-done reaches the daemon socket bus like pause/resume/cancel; the
driver's natural completion stays un-outboxed (exactly-once delivery)."
```

---

### Task 2: Dashboard `done` action on halted cards (`d` key)

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-state.ts:250-261` (`WorkflowAction`, `actionsForStatus`)
- Modify: `packages/cli/src/runtime/dashboard.ts:393-416` (`executeConfirmed`, `actionForKey`)
- Modify: `packages/cli/src/runtime/dashboard-view.tsx:31-35` (`ACTION_VERB`)
- Test: `test/dashboard-state.test.ts` (extend the `actionsForStatus` describe, ~line 689)
- Test: `test/dashboard-host.test.ts` (extend `fakeBroker`, add two tests after the p/r/c action tests ~line 562)

**Interfaces:**
- Consumes: `broker.control.markWorkflowDone({ workflowId, now })` from Task 1. `BrokerRuntime`'s control type picks it up automatically (dashboard.ts types `broker: BrokerRuntime` at line 108), so tsc will accept the call once Task 1 is merged.
- Produces: `WorkflowAction` union value `"done"` — anything switching on `WorkflowAction` must handle it (tsc enforces via the `Record<WorkflowAction, string>` in dashboard-view.tsx).

- [ ] **Step 1: Write the failing tests**

In `test/dashboard-state.test.ts`, update the existing `actionsForStatus` expectations (~line 689) — the `halted` line changes and a `done`-availability assertion is added:

```ts
describe("actionsForStatus", () => {
	it("maps status to available actions, mirroring broker guards", () => {
		expect(actionsForStatus("running")).toEqual(["pause", "cancel"]);
		expect(actionsForStatus("paused")).toEqual(["resume", "cancel"]);
		expect(actionsForStatus("halted")).toEqual(["resume", "done", "cancel"]);
		expect(actionsForStatus("done")).toEqual([]);
		expect(actionsForStatus("canceled")).toEqual([]);
		expect(actionsForStatus(null)).toEqual([]);
	});
});
```

(Adapt to the file's real describe/it structure — keep every existing assertion, change only `halted`, and ensure `done`/`canceled`/`null` still expect `[]`.)

In `test/dashboard-host.test.ts`:

1. Add `markWorkflowDone: vi.fn(),` to the `fakeBroker` control object, next to `cancelWorkflow: vi.fn(),` (line 31).
2. Add these two tests after the "a no-workflow (manual) card hints..." test (~line 562):

```ts
	it("d on a halted card opens a Mark done confirm; y calls broker.markWorkflowDone", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const broker = fakeBroker([S({ collabId: "c1", workflowId: "wf", workflowStatus: "halted", chainStatus: "escalated", currentRound: 1, maxRounds: 5 })]);
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string; escape?: boolean }): void;
			__pendingConfirm(): { workflowId: string; action: string } | null;
			__actionFeedback(): { kind: string; text: string } | null;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "d" });
		expect(m.__pendingConfirm()).toEqual({ workflowId: "wf", action: "done" });
		m.__handleKey({ key: "y" });
		expect(m.__pendingConfirm()).toBeNull();
		expect(broker.control.markWorkflowDone).toHaveBeenCalledTimes(1);
		expect(broker.control.markWorkflowDone.mock.calls[0]![0]).toMatchObject({ workflowId: "wf" });
		expect(m.__actionFeedback()).toMatchObject({ kind: "ok" });
		await m.stop();
	});

	it("d on a running card shows a hint and never calls the broker", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const broker = fakeBroker([S({ collabId: "c1", workflowId: "wf", workflowStatus: "running", chainStatus: "active", currentRound: 1, maxRounds: 5 })]);
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string }): void;
			__pendingConfirm(): unknown; __actionFeedback(): { kind: string } | null;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "d" });
		expect(m.__pendingConfirm()).toBeNull();
		expect(m.__actionFeedback()).toMatchObject({ kind: "hint" });
		expect(broker.control.markWorkflowDone).not.toHaveBeenCalled();
		await m.stop();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/dashboard-state.test.ts test/dashboard-host.test.ts`
Expected: the `halted` actions assertion FAILS (`["resume", "cancel"]` ≠ `["resume", "done", "cancel"]`); the `d`-key confirm test FAILS (`__pendingConfirm()` is null because `d` maps to no action).

- [ ] **Step 3: Implement the dashboard changes**

`packages/cli/src/runtime/dashboard-state.ts` — replace the `WorkflowAction`/`actionsForStatus` block (lines 250-261):

```ts
export type WorkflowAction = "pause" | "resume" | "cancel" | "done";

// Which actions the dashboard may offer for a workflow status. Mirrors the
// broker's own guards (workflow-control.ts) so the UI never opens a confirm for
// a transition the broker would reject. null = manual-relay slice (no workflow).
export function actionsForStatus(
	status: "running" | "paused" | "done" | "halted" | "canceled" | null,
): WorkflowAction[] {
	if (status === "running") return ["pause", "cancel"];
	if (status === "paused") return ["resume", "cancel"];
	if (status === "halted") return ["resume", "done", "cancel"];
	return [];
}
```

`packages/cli/src/runtime/dashboard.ts` — in `executeConfirmed` (~line 399), add the `done` branch and verb:

```ts
		try {
			if (action === "pause") c.pauseWorkflow({ workflowId, now });
			else if (action === "resume") c.resumeWorkflow({ workflowId, now });
			else if (action === "done") c.markWorkflowDone({ workflowId, now });
			else c.cancelWorkflow({ workflowId, now });
			const verb =
				action === "pause"
					? "paused"
					: action === "resume"
						? "resumed"
						: action === "done"
							? "marked done"
							: "canceled";
			setFeedback("ok", `${verb} ${workflowId}`);
		} catch (err) {
			setFeedback("err", err instanceof Error ? err.message : String(err));
		}
```

And in `actionForKey` (~line 411), add the `d` mapping:

```ts
	function actionForKey(key: string | undefined): WorkflowAction | null {
		if (key === "p") return "pause";
		if (key === "r") return "resume";
		if (key === "c") return "cancel";
		if (key === "d") return "done";
		return null;
	}
```

`packages/cli/src/runtime/dashboard-view.tsx` — extend `ACTION_VERB` (line 31; it is `Record<WorkflowAction, string>`, so tsc fails until this is added):

```ts
const ACTION_VERB: Record<WorkflowAction, string> = {
	pause: "Pause",
	resume: "Resume",
	cancel: "Cancel",
	done: "Mark done",
};
```

No other display change: the confirm modal renders `Mark done wf? (y/n)` via `ACTION_VERB`, and the stale-frame guard (`requestAction` → `freshStatusFor` → `actionsForStatus`) covers the new action automatically. `actionForKey` is shared by Wall and Inspector modes, so `d` works in both.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/dashboard-state.test.ts test/dashboard-host.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add packages/cli/src/runtime/dashboard-state.ts packages/cli/src/runtime/dashboard.ts packages/cli/src/runtime/dashboard-view.tsx test/dashboard-state.test.ts test/dashboard-host.test.ts
git commit -m "feat(cli): dashboard d-key marks a halted workflow done

Halted cards now offer resume/done/cancel; d opens the existing y/n
confirm modal and calls broker.control.markWorkflowDone. Running cards
hint that done is unavailable, mirroring the broker guard."
```

---

### Task 3: CLI command `whisper workflow complete <workflowId>`

**Files:**
- Create: `packages/cli/src/commands/workflow/complete.ts`
- Modify: `packages/cli/src/create-cli.ts` (import ~line 36, registration after the `cancel` command ~line 663)
- Test: `test/cli-workflow-commands.test.ts` (new tests at the end of the describe)

**Interfaces:**
- Consumes: `broker.control.markWorkflowDone({ workflowId, now })` from Task 1.
- Produces: `runWorkflowComplete(deps: WorkflowCompleteDeps): Promise<void>` — used only by create-cli.ts.

- [ ] **Step 1: Write the failing tests**

Append to the describe in `test/cli-workflow-commands.test.ts` (reuses the file's `boot()` helper and existing imports; add `import { runWorkflowComplete } from "../packages/cli/src/commands/workflow/complete.ts";` next to the other command imports):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/cli-workflow-commands.test.ts`
Expected: FAIL — `complete.ts` module does not exist.

- [ ] **Step 3: Create the command wrapper and register it**

Create `packages/cli/src/commands/workflow/complete.ts`:

```ts
export interface WorkflowCompleteDeps {
	broker: {
		control: {
			markWorkflowDone: (input: { workflowId: string; now: string }) => void;
		};
	};
	workflowId: string;
	now: string;
}

// markWorkflowDone is synchronous; async wrapper kept so callers can uniformly
// await workflow commands and catch thrown errors via Promise rejection.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowComplete(deps: WorkflowCompleteDeps): Promise<void> {
	deps.broker.control.markWorkflowDone({ workflowId: deps.workflowId, now: deps.now });
}
```

In `packages/cli/src/create-cli.ts`, add the import beside the other workflow command imports (~line 36):

```ts
import { runWorkflowComplete } from "./commands/workflow/complete.js";
```

Register the command directly after the `cancel` command block (~line 663):

```ts
	workflow
		.command("complete")
		.description("Mark a halted (escalated) workflow as done after manual verification")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({
				cwd: opts.workspace,
			});
			try {
				await runWorkflowComplete({
					broker,
					workflowId,
					now: new Date().toISOString(),
				});
				console.log(`Workflow marked done: ${workflowId}`);
			} finally {
				await broker.stop();
			}
		});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/cli-workflow-commands.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add packages/cli/src/commands/workflow/complete.ts packages/cli/src/create-cli.ts test/cli-workflow-commands.test.ts
git commit -m "feat(cli): add whisper workflow complete command

Marks a halted (escalated) workflow as done after the operator verified
the work manually. Mirrors the pause/resume/cancel wrapper shape."
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/workflows.md` (~line 160, after the "stop a run for good" line)
- Modify: `README.md` (~line 120, the "What happens if it fails?" paragraph)

**Interfaces:**
- Consumes: the shipped command name `whisper workflow complete <workflowId>` and dashboard key `d` from Tasks 2-3.
- Produces: nothing downstream.

- [ ] **Step 1: Update docs/workflows.md**

After the line `To stop a run for good: \`whisper workflow cancel <workflowId>\` (canceled workflows cannot be resumed).` (~line 160), append this paragraph:

```markdown
There is a third way out for an escalated run whose **work is actually complete**: sometimes a workflow halts only because the final verification was environment-blocked (an e2e suite that needs credentials or hardware the agents don't have). Verify the result yourself, then mark the run done — `whisper workflow complete <workflowId>`, or press `d` on the run's dashboard card. The run counts as done, with the operator completion recorded (`halt reason: marked done by operator`); resume/cancel semantics are untouched.
```

- [ ] **Step 2: Update README.md**

In the "What happens if it fails?" paragraph (~line 120), after the sentence ending `…and \`whisper workflow resume <id>\` to pick up where it left off.`, insert:

```markdown
If the work is actually complete and only the verification was environment-blocked, verify it yourself and mark the run done with `whisper workflow complete <id>` (or press `d` on its dashboard card).
```

Edit the ROOT `README.md` only — `packages/cli/README.md` is overwritten from it at build time by `copy-package-files.mjs`.

- [ ] **Step 3: Run the full gate**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all four exit 0. (The build step regenerates `packages/cli/README.md` from the root README — if it shows as modified afterwards, commit the regenerated copy together with the docs, matching how the tree is kept clean.)

- [ ] **Step 4: Commit**

```bash
git add docs/workflows.md README.md packages/cli/README.md
git commit -m "docs: document whisper workflow complete and the dashboard d key"
```

(If `packages/cli/README.md` was not regenerated/modified, drop it from the `git add`.)

---

## Final Verification

- [ ] Run the full gate from the repo root: `pnpm lint && pnpm typecheck && pnpm build && pnpm test` — all four must exit 0.
- [ ] `git status --short` — working tree clean.

## Spec Coverage Map

| Spec section | Task |
|---|---|
| Broker `markWorkflowDone` (atomic guard, sweep, turn-state `done`, emit-iff-transition) | Task 1 |
| Control-service exposure (automatic merge) | Task 1 (no-op, documented) |
| Outbox event-name contract: `workflow.done` added for CLI-side mark-done; driver-native done stays un-outboxed (exactly-once) | Task 1 (Step 3a + bridge re-emit test) |
| Dashboard action `done`, key `d`, confirm modal, stale-frame guard | Task 2 |
| CLI `whisper workflow complete` | Task 3 |
| Docs (workflows.md + root README) | Task 4 |
| Testing: broker guards / no-emit AND no-record on throw paths / sweep / double-done / terminal-chain | Task 1 |
| Testing: actionsForStatus, d-key confirm, invalid-status hint | Task 2 |
| Testing: CLI wrapper happy path + reject | Task 3 |
| Out of scope: paused completion, operator note, un-done, key legend | (excluded everywhere) |
