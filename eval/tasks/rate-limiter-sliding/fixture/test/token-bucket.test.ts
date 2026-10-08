import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/token-bucket.ts";

function bucket(capacity: number, refillPerSecond: number) {
	const clock = { t: 0 };
	return { clock, bucket: new TokenBucket({ capacity, refillPerSecond, now: () => clock.t }) };
}

describe("TokenBucket", () => {
	it("starts full and denies once drained", () => {
		const { bucket: b } = bucket(2, 1);
		expect(b.tryRemove()).toBe(true);
		expect(b.tryRemove()).toBe(true);
		expect(b.tryRemove()).toBe(false);
	});
	it("refills over time", () => {
		const { clock, bucket: b } = bucket(2, 2);
		b.tryRemove(2);
		expect(b.tryRemove()).toBe(false);
		clock.t = 500;
		expect(b.tryRemove()).toBe(true);
		expect(b.tryRemove()).toBe(false);
	});
	it("never refills beyond capacity", () => {
		const { clock, bucket: b } = bucket(2, 10);
		clock.t = 60_000;
		expect(b.tryRemove(2)).toBe(true);
		expect(b.tryRemove()).toBe(false);
	});
	it("denies requests larger than the available tokens", () => {
		const { bucket: b } = bucket(3, 1);
		expect(b.tryRemove(4)).toBe(false);
		expect(b.tryRemove(3)).toBe(true);
	});
});
