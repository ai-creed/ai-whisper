import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EVENT_PROTOCOL_VERSION,
	type EventSocketFrame,
} from "../packages/broker/src/runtime/event-protocol.ts";
import { createBrokerEventBus } from "../packages/broker/src/runtime/broker-event-bus.ts";
import {
	createEventSocketServer,
	ALL_BROKER_EVENT_NAMES,
	type EventSocketServer,
} from "../packages/broker/src/runtime/event-socket-server.ts";

describe("event-protocol constant", () => {
	it("pins the wire protocol version to the string \"1\"", () => {
		expect(EVENT_PROTOCOL_VERSION).toBe("1");
		// Contractual: it is a STRING, not a number (consumer validates with zod).
		expect(typeof EVENT_PROTOCOL_VERSION).toBe("string");
	});

	it("is re-exported from the broker package index", async () => {
		const broker = await import("../packages/broker/src/index.ts");
		expect(broker.EVENT_PROTOCOL_VERSION).toBe("1");
	});

	it("frame types discriminate on `type`", () => {
		const hello: EventSocketFrame = {
			type: "hello",
			engineVersion: "0.5.8",
			protocolVersion: EVENT_PROTOCOL_VERSION,
		};
		expect(hello.type).toBe("hello");
	});
});

function socketFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "evsock-"));
	return join(dir, "events-collab_test.sock");
}

// Reads newline-delimited JSON frames from a connected client.
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

type OpenEntry = { server: EventSocketServer; clients: Socket[] };

describe("createEventSocketServer", () => {
	const open: OpenEntry[] = [];
	afterEach(async () => {
		for (const o of open) {
			for (const c of o.clients) c.destroy();
			await o.server.close();
		}
		open.length = 0;
	});

	async function startServer(opts?: {
		engineVersion?: string;
		now?: () => string;
		path?: string;
	}): Promise<{
		entry: OpenEntry;
		bus: ReturnType<typeof createBrokerEventBus>;
		path: string;
	}> {
		const bus = createBrokerEventBus();
		const path = opts?.path ?? socketFile();
		const server = await createEventSocketServer({
			socketPath: path,
			events: bus,
			engineVersion: opts?.engineVersion ?? "9.9.9",
			...(opts?.now ? { now: opts.now } : {}),
		});
		const entry: OpenEntry = { server, clients: [] };
		open.push(entry);
		return { entry, bus, path };
	}

	function connectClient(
		entry: OpenEntry,
		path: string,
	): { conn: Socket; reader: ReturnType<typeof frameReader> } {
		const conn = connect(path);
		entry.clients.push(conn);
		return { conn, reader: frameReader(conn) };
	}

	it("writes a hello frame immediately on connect", async () => {
		const { entry, path } = await startServer({ engineVersion: "1.2.3" });
		const { reader } = connectClient(entry, path);
		await reader.waitFor(1);
		expect(reader.frames[0]).toEqual({
			type: "hello",
			engineVersion: "1.2.3",
			protocolVersion: "1",
		});
	});

	it("emits one event frame per bus emission, payload verbatim, with ts", async () => {
		const { entry, bus, path } = await startServer({
			now: () => "2026-06-12T10:00:00.000Z",
		});
		const { reader } = connectClient(entry, path);
		await reader.waitFor(1); // hello
		bus.emit("workflow.halted", { workflowId: "wf_x", reason: "boom" });
		await reader.waitFor(2);
		expect(reader.frames[1]).toEqual({
			type: "event",
			name: "workflow.halted",
			payload: { workflowId: "wf_x", reason: "boom" },
			ts: "2026-06-12T10:00:00.000Z",
		});
	});

	it("fans out every frame to multiple concurrent clients", async () => {
		const { entry, bus, path } = await startServer();
		const a = connectClient(entry, path);
		const b = connectClient(entry, path);
		await a.reader.waitFor(1);
		await b.reader.waitFor(1);
		bus.emit("workflow.paused", { workflowId: "wf_p" });
		await a.reader.waitFor(2);
		await b.reader.waitFor(2);
		expect(a.reader.frames[1]).toMatchObject({ name: "workflow.paused" });
		expect(b.reader.frames[1]).toMatchObject({ name: "workflow.paused" });
	});

	it("drops a dead client without throwing and keeps serving the rest", async () => {
		const { entry, bus, path } = await startServer();
		const a = connectClient(entry, path);
		const b = connectClient(entry, path);
		await a.reader.waitFor(1);
		await b.reader.waitFor(1);
		a.conn.destroy(); // dead client
		await new Promise((r) => setTimeout(r, 20));
		expect(() =>
			bus.emit("workflow.resumed", { workflowId: "wf_r", phaseIndex: 2 }),
		).not.toThrow();
		await b.reader.waitFor(2);
		expect(b.reader.frames[1]).toMatchObject({ name: "workflow.resumed" });
	});

	it("unlinks a stale socket file before binding", async () => {
		const path = socketFile();
		writeFileSync(path, ""); // residue from a crashed predecessor
		const { entry, path: bound } = await startServer({ path });
		expect(bound).toBe(path);
		const { reader } = connectClient(entry, path);
		await reader.waitFor(1); // a fresh listener is bound and serving
		expect(reader.frames[0]).toMatchObject({ type: "hello" });
	});

	it("close() removes the socket file", async () => {
		const { entry, path } = await startServer();
		expect(existsSync(path)).toBe(true);
		await entry.server.close();
		open.length = 0; // already closed; skip afterEach double-close
		expect(existsSync(path)).toBe(false);
	});

	it("ALL_BROKER_EVENT_NAMES covers exactly the 11 BrokerEventMap events", () => {
		expect([...ALL_BROKER_EVENT_NAMES].sort()).toEqual(
			[
				"chain.escalated",
				"chain.resolved",
				"workflow.canceled",
				"workflow.created",
				"workflow.done",
				"workflow.halted",
				"workflow.paused",
				"workflow.phase-done",
				"workflow.phase-started",
				"workflow.resumed",
				"workflow.round-started",
			].sort(),
		);
	});
});
