import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type {
	BrokerEventBus,
	BrokerEventName,
} from "./broker-event-bus.js";
import {
	EVENT_PROTOCOL_VERSION,
	type EventFrame,
	type HelloFrame,
} from "./event-protocol.js";

// Exhaustive table of every BrokerEventMap key → true. Because the type is
// Record<BrokerEventName, true>, adding a new event to BrokerEventMap WITHOUT
// listing it here is a compile error — the fanout can never silently drop an
// event name. This is the type-level exhaustiveness guard the contract requires.
const EVENT_NAME_TABLE: Record<BrokerEventName, true> = {
	"chain.resolved": true,
	"chain.escalated": true,
	"workflow.created": true,
	"workflow.phase-started": true,
	"workflow.round-started": true,
	"workflow.phase-done": true,
	"workflow.halted": true,
	"workflow.canceled": true,
	"workflow.done": true,
	"workflow.resumed": true,
	"workflow.paused": true,
};

export const ALL_BROKER_EVENT_NAMES = Object.keys(
	EVENT_NAME_TABLE,
) as BrokerEventName[];

export interface EventSocketServer {
	socketPath: string;
	close(): Promise<void>;
}

export interface CreateEventSocketServerInput {
	socketPath: string;
	events: BrokerEventBus;
	engineVersion: string;
	now?: () => string;
}

export async function createEventSocketServer(
	input: CreateEventSocketServerInput,
): Promise<EventSocketServer> {
	const now = input.now ?? (() => new Date().toISOString());
	const clients = new Set<Socket>();

	mkdirSync(dirname(input.socketPath), { recursive: true });
	// Clear a stale socket file left by a crashed predecessor before binding.
	if (existsSync(input.socketPath)) {
		try {
			unlinkSync(input.socketPath);
		} catch {
			/* ignore — listen() will surface a real conflict */
		}
	}

	function dropClient(conn: Socket): void {
		clients.delete(conn);
		try {
			conn.destroy();
		} catch {
			/* already gone */
		}
	}

	// A slow/dead client must never block the daemon or other clients: any write
	// error drops that client only.
	function writeLine(conn: Socket, line: string): void {
		try {
			conn.write(line);
		} catch {
			dropClient(conn);
		}
	}

	const server: Server = createServer((conn) => {
		clients.add(conn);
		conn.on("error", () => dropClient(conn));
		conn.on("close", () => clients.delete(conn));
		const hello: HelloFrame = {
			type: "hello",
			engineVersion: input.engineVersion,
			protocolVersion: EVENT_PROTOCOL_VERSION,
		};
		writeLine(conn, `${JSON.stringify(hello)}\n`);
	});

	const unsubscribes = ALL_BROKER_EVENT_NAMES.map((name) =>
		input.events.on(name, (payload) => {
			const frame: EventFrame = { type: "event", name, payload, ts: now() };
			const line = `${JSON.stringify(frame)}\n`;
			for (const conn of [...clients]) writeLine(conn, line);
		}),
	);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(input.socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	return {
		socketPath: input.socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				for (const unsub of unsubscribes) unsub();
				for (const conn of [...clients]) dropClient(conn);
				server.close(() => {
					try {
						if (existsSync(input.socketPath)) unlinkSync(input.socketPath);
					} catch {
						/* ignore */
					}
					resolve();
				});
			}),
	};
}
