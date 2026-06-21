import { describe, expect, it } from "vitest";
import { makeChangeCountReader } from "../packages/cli/src/runtime/clipboard-change-count.ts";

describe("changeCount reader", () => {
	it("parses an integer printed by the helper", async () => {
		const read = makeChangeCountReader({
			platform: "darwin",
			runHelper: async () => "42\n",
		});
		expect(await read()).toBe(42);
	});

	it("returns null when the helper errors", async () => {
		const read = makeChangeCountReader({
			platform: "darwin",
			runHelper: async () => {
				throw new Error("helper missing");
			},
		});
		expect(await read()).toBeNull();
	});

	it("returns null on non-darwin without invoking the helper", async () => {
		let called = false;
		const read = makeChangeCountReader({
			platform: "linux",
			runHelper: async () => {
				called = true;
				return "1";
			},
		});
		expect(await read()).toBeNull();
		expect(called).toBe(false);
	});

	it("returns null when the helper prints non-numeric output", async () => {
		const read = makeChangeCountReader({
			platform: "darwin",
			runHelper: async () => "not-a-number",
		});
		expect(await read()).toBeNull();
	});
});

describe("changeCount reader — timeout", () => {
	it("returns null when the helper rejects with a CaptureIoTimeoutError", async () => {
		const read = makeChangeCountReader({
			platform: "darwin",
			runHelper: async () => {
				throw new Error("changeCount timed out");
			},
		});
		expect(await read()).toBeNull();
	});
});
