import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LruCache } from "../src/lru.ts";

function clocked(capacity: number, ttlMs?: number) {
	const clock = { t: 0 };
	const cache = new LruCache<string, number>(capacity, { ttlMs, now: () => clock.t });
	return { clock, cache };
}

describe("LruCache TTL (held-out)", () => {
	it("expires exactly at ttl boundary", () => {
		const { clock, cache } = clocked(2);
		cache.set("a", 1, 100);
		clock.t = 99;
		expect(cache.get("a")).toBe(1);
		clock.t = 100;
		expect(cache.get("a")).toBeUndefined();
	});
	it("has mirrors get after expiry", () => {
		const { clock, cache } = clocked(2);
		cache.set("a", 1, 100);
		clock.t = 99;
		expect(cache.has("a")).toBe(true);
		clock.t = 100;
		expect(cache.has("a")).toBe(false);
	});
	it("size excludes expired", () => {
		const { clock, cache } = clocked(2);
		cache.set("a", 1, 10);
		cache.set("b", 2, 1000);
		clock.t = 10;
		expect(cache.size).toBe(1);
	});
	it("per-set ttl overrides default", () => {
		const { clock, cache } = clocked(3, 100);
		cache.set("short", 1, 10);
		cache.set("default", 2);
		clock.t = 10;
		expect(cache.get("short")).toBeUndefined();
		expect(cache.get("default")).toBe(2);
		clock.t = 100;
		expect(cache.get("default")).toBeUndefined();
	});
	it("no ttl never expires", () => {
		const { clock, cache } = clocked(2);
		cache.set("a", 1);
		clock.t = 1e9;
		expect(cache.get("a")).toBe(1);
	});
	it("expired entry evicted before LRU live entry", () => {
		const { clock, cache } = clocked(2);
		cache.set("a", 1, 10);
		cache.set("b", 2);
		clock.t = 20;
		cache.set("c", 3);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
		// the expired entry is the newer one: the older live entry must survive
		const second = clocked(2);
		second.cache.set("live", 1);
		second.cache.set("stale", 2, 10);
		second.clock.t = 20;
		second.cache.set("fresh", 3);
		expect(second.cache.get("live")).toBe(1);
		expect(second.cache.get("stale")).toBeUndefined();
		expect(second.cache.get("fresh")).toBe(3);
	});
	it("module does not call Date.now", () => {
		const src = readFileSync(`${import.meta.dirname}/../src/lru.ts`, "utf8");
		expect(!/Date\.now/.test(src)).toBe(true);
	});
});
