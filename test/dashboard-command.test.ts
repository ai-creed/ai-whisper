import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { runCollabDashboard } from "../packages/cli/src/commands/collab/dashboard.ts";

describe("runCollabDashboard", () => {
	it("forwards showAll to the runtime factory", async () => {
		const fakeRuntime = { start: vi.fn(), stop: vi.fn(async () => {}), waitUntilStopped: vi.fn(async () => {}) };
		const createRuntime = vi.fn(() => fakeRuntime as never);
		await runCollabDashboard({
			stdout: new PassThrough() as unknown as NodeJS.WritableStream,
			showAll: true,
			__createBroker: () => ({ stop: vi.fn(async () => {}) }) as never,
			__createRuntime: createRuntime as never,
			__noSignals: true,
		});
		const call = createRuntime.mock.calls[0] as unknown as unknown[];
		const opts = call?.[3] as { showAll?: boolean } | undefined;
		expect(opts?.showAll).toBe(true);
	});

	it("builds a broker, runs the dashboard runtime, stops on SIGINT-equivalent", async () => {
		const stop = vi.fn(async () => {});
		const waitUntilStopped = vi.fn(async () => {});
		const start = vi.fn();
		const fakeRuntime = { start, stop, waitUntilStopped };
		const brokerStop = vi.fn(async () => {});
		await runCollabDashboard({
			stdout: new PassThrough() as unknown as NodeJS.WritableStream,
			__createBroker: () => ({ stop: brokerStop }) as never,
			__createRuntime: () => fakeRuntime as never,
			__noSignals: true,
		});
		expect(start).toHaveBeenCalledTimes(1);
		expect(waitUntilStopped).toHaveBeenCalledTimes(1);
		expect(brokerStop).toHaveBeenCalledTimes(1);
	});
});
