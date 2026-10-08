import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as index from "../src/index.ts";
import { SlidingWindowLimiter } from "../src/sliding-window.ts";
import { TokenBucket } from "../src/token-bucket.ts";

function windowed(limit = 3, windowMs = 1000) {
	const clock = { t: 0 };
	return { clock, limiter: new SlidingWindowLimiter({ limit, windowMs, now: () => clock.t }) };
}

function bucket(capacity: number, refillPerSecond: number) {
	const clock = { t: 0 };
	return { clock, bucket: new TokenBucket({ capacity, refillPerSecond, now: () => clock.t }) };
}

describe("rate limiters (held-out)", () => {
	it("allows limit then denies", () => {
		const { limiter } = windowed();
		expect(limiter.tryAcquire()).toBe(true);
		expect(limiter.tryAcquire()).toBe(true);
		expect(limiter.tryAcquire()).toBe(true);
		expect(limiter.tryAcquire()).toBe(false);
	});
	it("retryAfterMs when denied", () => {
		const { clock, limiter } = windowed();
		expect(limiter.retryAfterMs()).toBe(0);
		for (let i = 0; i < 3; i++) limiter.tryAcquire();
		expect(limiter.tryAcquire()).toBe(false);
		expect(limiter.retryAfterMs()).toBe(1000);
		clock.t = 400;
		expect(limiter.retryAfterMs()).toBe(600);
	});
	it("boundary inclusive at windowMs", () => {
		const { clock, limiter } = windowed();
		for (let i = 0; i < 3; i++) limiter.tryAcquire();
		clock.t = 999;
		expect(limiter.tryAcquire()).toBe(false);
		clock.t = 1000;
		expect(limiter.tryAcquire()).toBe(true);
	});
	it("prunes old timestamps", () => {
		const { clock, limiter } = windowed();
		for (let step = 0; step < 200; step++) {
			clock.t = step * 100;
			limiter.tryAcquire();
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((limiter as any).timestamps.length).toBeLessThanOrEqual(3);
	});
	it("token bucket tryAcquire alias", () => {
		const { clock, bucket: b } = bucket(2, 2);
		expect(b.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(false);
		clock.t = 500;
		expect(b.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(false);
	});
	it("token bucket retryAfterMs when empty", () => {
		const { clock, bucket: b } = bucket(2, 4);
		expect(b.retryAfterMs()).toBe(0);
		b.tryRemove(2);
		expect(b.retryAfterMs()).toBe(250);
		clock.t = 100;
		expect(b.retryAfterMs()).toBe(150);
	});
	it("index exports Limiter-compatible classes", () => {
		const clock = { t: 0 };
		const now = () => clock.t;
		const a = new index.TokenBucket({ capacity: 1, refillPerSecond: 1, now });
		const b = new index.SlidingWindowLimiter({ limit: 1, windowMs: 1000, now });
		for (const limiter of [a, b]) {
			expect(typeof limiter.tryAcquire).toBe("function");
			expect(typeof limiter.retryAfterMs).toBe("function");
		}
	});
	it("no Date.now in src", () => {
		const dir = `${import.meta.dirname}/../src`;
		const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			expect(/Date\.now/.test(readFileSync(`${dir}/${f}`, "utf8"))).toBe(false);
		}
	});
});
