import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
	join(process.cwd(), "packages/cli/src/bin/broker-daemon.ts"),
	"utf8",
);

describe("broker daemon event-socket wiring", () => {
	it("creates the fanout server with the deterministic socket path", () => {
		expect(src).toContain("createEventSocketServer");
		expect(src).toContain("events-${collabId}.sock");
		expect(src).toContain("getStateSocketsDir");
	});

	it("feeds the fanout the broker event bus and resolved engine version", () => {
		expect(src).toContain("broker.events");
		expect(src).toContain("resolveCliVersion()");
	});

	it("bridges cross-process workflow events on a dedicated bus, not broker.events", () => {
		// The bridge surfaces CLI-originated start/pause/resume/cancel events that
		// never reach the daemon bus. It must run on a separate bus the socket
		// also fans out — kept off broker.events so the driver is not triggered.
		expect(src).toContain("createWorkflowEventBridge");
		expect(src).toContain("createBrokerEventBus");
		expect(src).toContain("workflowEventBridge.start()");
		// Socket fans out BOTH buses.
		expect(src).toContain("events: [broker.events, externalEvents]");
		// The bridge emits on the dedicated external bus, not the driving bus.
		expect(src).toContain("events: externalEvents");
	});

	it("stops the bridge and closes the socket on shutdown BEFORE stopping the broker", () => {
		const shutdownIdx = src.indexOf("async function shutdown");
		expect(shutdownIdx).toBeGreaterThan(-1);
		const body = src.slice(shutdownIdx);
		expect(body).toContain("workflowEventBridge?.stop()");
		expect(body).toContain("eventSocket?.close()");
		expect(body.indexOf("workflowEventBridge?.stop()")).toBeLessThan(
			body.indexOf("broker.stop()"),
		);
		expect(body.indexOf("eventSocket?.close()")).toBeLessThan(
			body.indexOf("broker.stop()"),
		);
	});
});
