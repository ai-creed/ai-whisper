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

	it("closes the socket on shutdown BEFORE stopping the broker", () => {
		const shutdownIdx = src.indexOf("async function shutdown");
		expect(shutdownIdx).toBeGreaterThan(-1);
		const body = src.slice(shutdownIdx);
		expect(body).toContain("eventSocket?.close()");
		expect(body.indexOf("eventSocket?.close()")).toBeLessThan(
			body.indexOf("broker.stop()"),
		);
	});
});
