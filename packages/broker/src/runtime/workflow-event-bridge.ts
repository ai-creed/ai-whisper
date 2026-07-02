import type Database from "better-sqlite3";
import type { BrokerEventBus } from "./broker-event-bus.js";
import {
	getMaxWorkflowEventId,
	listWorkflowEventsAfter,
} from "../storage/repositories/workflow-event-outbox-repository.js";

export interface WorkflowEventBridge {
	start(): void;
	stop(): void;
	/** Drain the outbox once and emit any new rows. Exposed for deterministic tests. */
	tick(): void;
}

// Surfaces CLI-originated workflow lifecycle events on the daemon's
// external-notification bus.
//
// Why this exists: `whisper workflow start/pause/resume/cancel` run on a
// TRANSIENT BrokerRuntime (see runtime/broker-connect.ts) with its own
// in-process event bus, so the workflow.created/paused/resumed/canceled events
// they emit never reach the daemon process. Those control commands also append
// each event to an APPEND-ONLY outbox table (workflow_event_outbox); the daemon
// tails that log here and re-emits every row in order. Tailing an append-only
// log — rather than diffing a status snapshot — is what makes delivery reliable:
// a rapid pause→resume between two ticks leaves TWO ordered rows, so neither
// frame is lost.
//
// IMPORTANT: the bus passed here MUST NOT be the daemon's driving bus
// (`broker.events`). The workflow driver subscribes to workflow.created/resumed
// there to kick off phases; re-emitting them would trigger driving side-effects
// and race the driver's own sweep. The daemon wires this onto a dedicated bus
// that only the event socket consumes, so driving behavior is left exactly
// as-is. Driver-native events (phase/round/halted, and the driver's own
// natural workflow.done) are never outboxed; workflow.done is outboxed ONLY
// by operator mark-done, so the socket sees each event exactly once.
export function createWorkflowEventBridge(input: {
	db: Database.Database;
	events: BrokerEventBus;
	collabId: string;
	intervalMs: number;
}): WorkflowEventBridge {
	// Highest outbox id already delivered. Seeded on the first tick to the current
	// max so a daemon restart never replays history (consumers read live state
	// from the DB on connect).
	let lastId = 0;
	let seeded = false;
	let timer: NodeJS.Timeout | null = null;

	function tick(): void {
		if (!seeded) {
			lastId = getMaxWorkflowEventId(input.db, input.collabId);
			seeded = true;
			return;
		}
		const rows = listWorkflowEventsAfter(input.db, {
			collabId: input.collabId,
			afterId: lastId,
		});
		for (const row of rows) {
			// The outbox holds only CLI-originated lifecycle events, each
			// written with its BrokerEventMap payload shape by workflow-control, so
			// the (name, payload) pair is replayed verbatim. Emitted as a method
			// call (never an extracted reference) and type-erased via `never` for
			// the dynamic name→payload dispatch.
			input.events.emit(row.eventName as never, row.payload as never);
			lastId = row.id;
		}
	}

	return {
		tick,
		start() {
			if (timer) return;
			tick(); // seed immediately so the first interval tick already delivers
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
