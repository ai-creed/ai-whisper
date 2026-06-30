import { describe, expect, it } from "vitest";
import { isPidAlive } from "../packages/broker/src/runtime/broker-daemon-sweep.ts";

describe("isPidAlive", () => {
	it("reports the current process as alive", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("reports an almost-certainly-dead pid as not alive", () => {
		// 2^30 is far above any real pid on these platforms → ESRCH.
		expect(isPidAlive(1 << 30)).toBe(false);
	});
});
