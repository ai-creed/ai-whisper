import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync as mkdtemp, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	createBrokerEventBus,
	type BrokerEventBus,
	type BrokerEventName,
} from "../packages/broker/src/runtime/broker-event-bus.ts";
import { ALL_BROKER_EVENT_NAMES } from "../packages/broker/src/runtime/event-socket-server.ts";
import { createWorkflowEventBridge } from "../packages/broker/src/runtime/workflow-event-bridge.ts";
import { createEventSocketServer } from "../packages/broker/src/runtime/event-socket-server.ts";
import {
	appendWorkflowEvent,
	listWorkflowEventsAfter,
	type WorkflowOutboxEventName,
} from "../packages/broker/src/storage/repositories/workflow-event-outbox-repository.ts";

const COLLAB = "collab_bridge_test";

function freshDb() {
	const dir = mkdtemp(join(tmpdir(), "wf-bridge-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function append(
	db: ReturnType<typeof freshDb>,
	eventName: WorkflowOutboxEventName,
	payload: Record<string, unknown>,
	collabId = COLLAB,
): void {
	appendWorkflowEvent(db, {
		collabId,
		eventName,
		payload,
		now: "2026-06-12T00:00:00.000Z",
	});
}

function collect(bus: BrokerEventBus): Array<{ name: BrokerEventName; payload: unknown }> {
	const events: Array<{ name: BrokerEventName; payload: unknown }> = [];
	for (const name of ALL_BROKER_EVENT_NAMES) {
		bus.on(name, (payload) => events.push({ name, payload }));
	}
	return events;
}

describe("createWorkflowEventBridge (append-only outbox tail)", () => {
	it("seeds on the first tick without replaying pre-existing rows", () => {
		const db = freshDb();
		append(db, "workflow.created", { workflowId: "wf_old" });
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed → lastId = max(existing)
		expect(seen).toHaveLength(0);
	});

	it("delivers each appended lifecycle event verbatim", () => {
		const db = freshDb();
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed empty
		append(db, "workflow.paused", { workflowId: "wf_a" });
		append(db, "workflow.resumed", { workflowId: "wf_a", phaseIndex: 2 });
		append(db, "workflow.canceled", { workflowId: "wf_a", reason: "operator canceled" });
		bridge.tick();
		expect(seen).toEqual([
			{ name: "workflow.paused", payload: { workflowId: "wf_a" } },
			{ name: "workflow.resumed", payload: { workflowId: "wf_a", phaseIndex: 2 } },
			{ name: "workflow.canceled", payload: { workflowId: "wf_a", reason: "operator canceled" } },
		]);
	});

	// The exact reliability property the prior review blocked on: a pause and a
	// resume that land between two ticks must BOTH be delivered. With snapshot
	// polling the status read 'running' before and after, losing both frames;
	// tailing the append-only outbox preserves them as two ordered rows.
	it("delivers BOTH frames when pause+resume occur between ticks (no lost transition)", () => {
		const db = freshDb();
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed
		append(db, "workflow.paused", { workflowId: "wf_x" });
		append(db, "workflow.resumed", { workflowId: "wf_x", phaseIndex: 0 });
		bridge.tick(); // single tick after BOTH writes
		expect(seen.map((e) => e.name)).toEqual([
			"workflow.paused",
			"workflow.resumed",
		]);
	});

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

	it("does not re-deliver rows on a subsequent tick", () => {
		const db = freshDb();
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed
		append(db, "workflow.paused", { workflowId: "wf_a" });
		bridge.tick();
		bridge.tick(); // no new rows
		expect(seen).toHaveLength(1);
	});

	it("ignores outbox rows from other collabs", () => {
		const db = freshDb();
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed
		append(db, "workflow.paused", { workflowId: "wf_other" }, "collab_other");
		bridge.tick();
		expect(seen).toHaveLength(0);
	});
});

describe("real control → outbox → bridge (end-to-end wiring)", () => {
	it("create/pause/resume via control are all delivered by the bridge in one tick", () => {
		// A control-only runtime mirrors the transient CLI runtime (whisper
		// workflow start/pause/resume): it writes the shared DB but its bus is not
		// the daemon's socket bus.
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4322,
			runWorkflowDriver: false,
			runDiagnosticsSweep: false,
			runDaemonHeartbeat: false,
			runBrokerDaemonSweep: false,
		});
		broker.control.startCollab({
			collabId: COLLAB,
			workspaceRoot: "/tmp",
			displayName: "c",
			orchestratorEnabled: true,
			orchestratorMaxRounds: 3,
			now: "2026-06-12T00:00:00Z",
		});
		for (const agent of ["claude", "codex"] as const) {
			broker.control.setSessionBinding({
				collabId: COLLAB,
				agentType: agent,
				sessionId: `session_${agent}`,
				bindingSource: "adopted",
				now: "2026-06-12T00:00:00Z",
			});
		}

		// The daemon's bridge runs on a SEPARATE bus and tails broker.db.
		const socketBus = createBrokerEventBus();
		const seen = collect(socketBus);
		const bridge = createWorkflowEventBridge({
			db: broker.db,
			events: socketBus,
			collabId: COLLAB,
			intervalMs: 999_999,
		});
		bridge.tick(); // seed (outbox empty)

		const { workflowId } = broker.control.createWorkflow({
			collabId: COLLAB,
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-06-12T00:01:00Z",
		});
		broker.control.pauseWorkflow({ workflowId, now: "2026-06-12T00:02:00Z" });
		broker.control.resumeWorkflow({ workflowId, now: "2026-06-12T00:03:00Z" });

		// The outbox captured every transition, append-only.
		expect(
			listWorkflowEventsAfter(broker.db, { collabId: COLLAB, afterId: 0 }).map(
				(r) => r.eventName,
			),
		).toEqual(["workflow.created", "workflow.paused", "workflow.resumed"]);

		bridge.tick(); // one tick delivers all three
		expect(seen.map((e) => e.name)).toEqual([
			"workflow.created",
			"workflow.paused",
			"workflow.resumed",
		]);

		void broker.stop();
	});
});

// Reproduces AC #2 end-to-end over a real socket: a transition recorded only in
// the DB (the transient CLI runtime writes the outbox; it never emits on the
// daemon's buses) reaches a socket client — including a rapid pause+resume —
// while the daemon's driving bus is never touched by the bridge.
describe("event socket + workflow bridge (cross-process pause/resume wakeup)", () => {
	const sockets: Socket[] = [];
	const closers: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const s of sockets) s.destroy();
		sockets.length = 0;
		for (const close of closers) await close();
		closers.length = 0;
	});

	function frameReader(conn: Socket) {
		let buf = "";
		const frames: Array<Record<string, unknown>> = [];
		let notify: (() => void) | null = null;
		conn.on("data", (d) => {
			buf += d.toString("utf8");
			let idx: number;
			while ((idx = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (line.trim()) frames.push(JSON.parse(line) as Record<string, unknown>);
			}
			notify?.();
		});
		return {
			frames,
			async waitFor(count: number): Promise<void> {
				while (frames.length < count) {
					await new Promise<void>((resolve) => {
						notify = resolve;
					});
				}
			},
		};
	}

	it("DB-only pause→resume both reach the socket; the driving bus is never touched", async () => {
		const db = freshDb();

		const driverBus = createBrokerEventBus(); // stands in for daemon broker.events
		const externalBus = createBrokerEventBus(); // dedicated bridge bus

		let driverPausedCount = 0;
		driverBus.on("workflow.paused", () => {
			driverPausedCount += 1;
		});

		const dir = mkdtemp(join(tmpdir(), "wf-bridge-sock-"));
		const socketPath = join(dir, "events-collab_bridge_test.sock");
		const server = await createEventSocketServer({
			socketPath,
			events: [driverBus, externalBus],
			engineVersion: "9.9.9",
		});
		closers.push(() => server.close());

		const bridge = createWorkflowEventBridge({
			db,
			events: externalBus,
			collabId: COLLAB,
			intervalMs: 999_999,
		});
		bridge.tick(); // seed empty

		const conn = connect(socketPath);
		sockets.push(conn);
		const reader = frameReader(conn);
		await reader.waitFor(1); // hello
		expect(reader.frames[0]).toMatchObject({ type: "hello" });
		expect(existsSync(socketPath)).toBe(true);

		// Simulate the transient CLI runtime: write the outbox only (no bus emit),
		// pausing and resuming before the next bridge tick.
		append(db, "workflow.paused", { workflowId: "wf_x" });
		append(db, "workflow.resumed", { workflowId: "wf_x", phaseIndex: 0 });
		bridge.tick();

		await reader.waitFor(3); // hello + paused + resumed
		expect(reader.frames[1]).toMatchObject({
			type: "event",
			name: "workflow.paused",
			payload: { workflowId: "wf_x" },
		});
		expect(reader.frames[2]).toMatchObject({
			type: "event",
			name: "workflow.resumed",
			payload: { workflowId: "wf_x", phaseIndex: 0 },
		});

		// A daemon-native event on the driving bus still reaches the socket.
		driverBus.emit("workflow.halted", { workflowId: "wf_x", reason: "boom" });
		await reader.waitFor(4);
		expect(reader.frames[3]).toMatchObject({ name: "workflow.halted" });

		// The bridge must NOT have emitted on the driving bus.
		expect(driverPausedCount).toBe(0);
	});
});
