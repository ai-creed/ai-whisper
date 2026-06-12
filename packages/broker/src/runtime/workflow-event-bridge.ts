import type Database from "better-sqlite3";
import type { BrokerEventBus } from "./broker-event-bus.js";
import {
	listWorkflows,
	type WorkflowRecord,
} from "../storage/repositories/workflow-repository.js";

export interface WorkflowEventBridge {
	start(): void;
	stop(): void;
	/** Poll once and emit any observed transitions. Exposed for deterministic tests. */
	tick(): void;
}

// Surfaces CLI-originated workflow lifecycle transitions on the daemon's
// external-notification bus.
//
// Why this exists: `whisper workflow start/pause/resume/cancel` run on a
// TRANSIENT BrokerRuntime (see runtime/broker-connect.ts) with its own
// in-process event bus, so the `workflow.created/paused/resumed/canceled`
// events they emit never reach the daemon process. The daemon's own driver
// emits phase/round/halted/done in-process, so those already reach the socket;
// the four lifecycle events below are the gap. SQLite has no cross-process
// notification, so the daemon polls the `workflows` table and re-emits the
// transitions it observes.
//
// IMPORTANT: the bus passed here MUST NOT be the daemon's driving bus
// (`broker.events`). The workflow driver subscribes to `workflow.created` and
// `workflow.resumed` to kick off phases; emitting them onto the driving bus
// would trigger driving side-effects and race the driver's own DB sweep. The
// daemon wires this onto a dedicated bus that only the event socket consumes,
// so driving behavior is left exactly as-is.
export function createWorkflowEventBridge(input: {
	db: Database.Database;
	events: BrokerEventBus;
	collabId: string;
	intervalMs: number;
}): WorkflowEventBridge {
	// Last observed status per workflowId. Seeded on the first tick WITHOUT
	// emitting, so a daemon restart never replays pre-existing workflows as
	// fresh transitions.
	const lastStatus = new Map<string, WorkflowRecord["status"]>();
	let seeded = false;
	let timer: NodeJS.Timeout | null = null;

	function emitTransition(
		prev: WorkflowRecord["status"] | undefined,
		wf: WorkflowRecord,
	): void {
		if (prev === undefined) {
			// Newly observed after seeding → the CLI just created it.
			input.events.emit("workflow.created", { workflowId: wf.workflowId });
			return;
		}
		if (wf.status === "paused") {
			input.events.emit("workflow.paused", { workflowId: wf.workflowId });
			return;
		}
		if (wf.status === "running" && (prev === "paused" || prev === "halted")) {
			input.events.emit("workflow.resumed", {
				workflowId: wf.workflowId,
				phaseIndex: wf.currentPhaseIndex,
			});
			return;
		}
		if (wf.status === "canceled") {
			input.events.emit("workflow.canceled", {
				workflowId: wf.workflowId,
				reason: wf.haltReason ?? "canceled",
			});
			return;
		}
		// running→done and running→halted are emitted by the daemon driver
		// in-process; bridging them here would double-emit, so they are skipped.
	}

	function tick(): void {
		const rows = listWorkflows(input.db, { collabId: input.collabId });
		if (!seeded) {
			for (const wf of rows) lastStatus.set(wf.workflowId, wf.status);
			seeded = true;
			return;
		}
		for (const wf of rows) {
			const prev = lastStatus.get(wf.workflowId);
			lastStatus.set(wf.workflowId, wf.status);
			if (prev !== wf.status) emitTransition(prev, wf);
		}
	}

	return {
		tick,
		start() {
			if (timer) return;
			// Seed immediately so the first interval tick already detects transitions.
			tick();
			timer = setInterval(() => {
				try {
					tick();
				} catch {
					// Non-fatal: the next tick retries. Never crash the daemon over a
					// transient read error.
				}
			}, input.intervalMs);
			timer.unref();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
