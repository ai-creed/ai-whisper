import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import {
	createBrokerEventBus,
	type BrokerEventBus,
	type BrokerEventName,
} from "../packages/broker/src/runtime/broker-event-bus.ts";
import { ALL_BROKER_EVENT_NAMES } from "../packages/broker/src/runtime/event-socket-server.ts";
import { createWorkflowEventBridge } from "../packages/broker/src/runtime/workflow-event-bridge.ts";
import { createEventSocketServer } from "../packages/broker/src/runtime/event-socket-server.ts";
import {
	insertWorkflow,
	setWorkflowStatus,
	type WorkflowStatus,
} from "../packages/broker/src/storage/repositories/workflow-repository.ts";

const COLLAB = "collab_bridge_test";

function freshDb() {
	const dir = mkdtemp(join(tmpdir(), "wf-bridge-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function seedWorkflow(
	db: ReturnType<typeof freshDb>,
	workflowId: string,
	status: WorkflowStatus,
): void {
	insertWorkflow(db, {
		workflowId,
		collabId: COLLAB,
		workflowType: "spec-driven-development",
		name: null,
		specPath: "/spec.md",
		roleBindings: {},
		status,
		currentPhaseIndex: 0,
		workflowContext: {},
		now: "2026-06-12T00:00:00.000Z",
	});
}

function setStatus(
	db: ReturnType<typeof freshDb>,
	workflowId: string,
	status: WorkflowStatus,
	phaseIndex = 0,
): void {
	setWorkflowStatus(db, {
		workflowId,
		status,
		haltReason: status === "canceled" ? "operator canceled" : null,
		now: "2026-06-12T00:01:00.000Z",
	});
	if (phaseIndex !== 0) {
		db.prepare("UPDATE workflows SET current_phase_index = ? WHERE workflow_id = ?").run(
			phaseIndex,
			workflowId,
		);
	}
}

function collect(bus: BrokerEventBus): Array<{ name: BrokerEventName; payload: unknown }> {
	const events: Array<{ name: BrokerEventName; payload: unknown }> = [];
	for (const name of ALL_BROKER_EVENT_NAMES) {
		bus.on(name, (payload) => events.push({ name, payload }));
	}
	return events;
}

describe("createWorkflowEventBridge (DB→bus transition detection)", () => {
	it("seeds on the first tick without replaying existing workflows", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_seed", "running");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed
		expect(seen).toHaveLength(0);
	});

	it("emits workflow.paused on running→paused", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_p", "running");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed running
		setStatus(db, "wf_p", "paused");
		bridge.tick();
		expect(seen).toEqual([
			{ name: "workflow.paused", payload: { workflowId: "wf_p" } },
		]);
	});

	it("emits workflow.resumed (with phaseIndex) on paused→running", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_r", "paused");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed paused
		setStatus(db, "wf_r", "running", 2);
		bridge.tick();
		expect(seen).toEqual([
			{ name: "workflow.resumed", payload: { workflowId: "wf_r", phaseIndex: 2 } },
		]);
	});

	it("emits workflow.resumed on halted→running (resume of a halted workflow)", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_h", "halted");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed halted
		setStatus(db, "wf_h", "running");
		bridge.tick();
		expect(seen).toEqual([
			{ name: "workflow.resumed", payload: { workflowId: "wf_h", phaseIndex: 0 } },
		]);
	});

	it("emits workflow.canceled on →canceled with a reason", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_c", "running");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick();
		setStatus(db, "wf_c", "canceled");
		bridge.tick();
		expect(seen).toEqual([
			{
				name: "workflow.canceled",
				payload: { workflowId: "wf_c", reason: "operator canceled" },
			},
		]);
	});

	it("emits workflow.created when a workflow first appears after seeding", () => {
		const db = freshDb();
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed (no workflows yet)
		seedWorkflow(db, "wf_new", "running");
		bridge.tick();
		expect(seen).toEqual([
			{ name: "workflow.created", payload: { workflowId: "wf_new" } },
		]);
	});

	it("does NOT bridge running→done (driver emits it in-process)", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_done", "running");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed running
		setStatus(db, "wf_done", "done");
		bridge.tick();
		expect(seen).toHaveLength(0);
	});

	it("does NOT bridge running→halted (driver emits it in-process)", () => {
		const db = freshDb();
		seedWorkflow(db, "wf_halt", "running");
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick(); // seed running
		setStatus(db, "wf_halt", "halted");
		bridge.tick();
		expect(seen).toHaveLength(0);
	});

	it("ignores workflows from other collabs", () => {
		const db = freshDb();
		insertWorkflow(db, {
			workflowId: "wf_other",
			collabId: "collab_other",
			workflowType: "spec-driven-development",
			name: null,
			specPath: "/s.md",
			roleBindings: {},
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-06-12T00:00:00.000Z",
		});
		const bus = createBrokerEventBus();
		const seen = collect(bus);
		const bridge = createWorkflowEventBridge({ db, events: bus, collabId: COLLAB, intervalMs: 1 });
		bridge.tick();
		setWorkflowStatus(db, {
			workflowId: "wf_other",
			status: "paused",
			haltReason: null,
			now: "2026-06-12T00:02:00.000Z",
		});
		bridge.tick();
		expect(seen).toHaveLength(0);
	});
});

// Reproduces the reviewer's AC #2 scenario end-to-end: a workflow paused by a
// SEPARATE writer (the transient CLI runtime writes the DB; it never emits on
// the daemon's buses) must still produce a `workflow.paused` socket frame — via
// the bridge — WITHOUT the bridge ever touching the daemon's driving bus.
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

	it("a DB-only pause produces a socket frame; the driving bus is never touched", async () => {
		const db = freshDb();
		seedWorkflow(db, "wf_x", "running");

		// driverBus stands in for the daemon's broker.events (workflow driver
		// subscribes here). externalBus is the dedicated bridge bus.
		const driverBus = createBrokerEventBus();
		const externalBus = createBrokerEventBus();

		// Prove the bridge never emits onto the driving bus.
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
		bridge.tick(); // seed running

		const conn = connect(socketPath);
		sockets.push(conn);
		const reader = frameReader(conn);
		await reader.waitFor(1); // hello
		expect(reader.frames[0]).toMatchObject({ type: "hello" });

		// Simulate `whisper workflow pause`: write the DB only (no bus emit).
		setStatus(db, "wf_x", "paused");
		bridge.tick();
		await reader.waitFor(2);
		expect(reader.frames[1]).toMatchObject({
			type: "event",
			name: "workflow.paused",
			payload: { workflowId: "wf_x" },
		});

		// A daemon-native event on the driving bus still reaches the socket.
		driverBus.emit("workflow.halted", { workflowId: "wf_x", reason: "boom" });
		await reader.waitFor(3);
		expect(reader.frames[2]).toMatchObject({ name: "workflow.halted" });

		// The bridge must NOT have emitted paused on the driving bus.
		expect(driverPausedCount).toBe(0);
	});
});
