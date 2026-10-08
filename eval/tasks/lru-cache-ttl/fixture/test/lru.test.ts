import { describe, expect, it } from "vitest";
import { LruCache } from "../src/lru.ts";

describe("LruCache", () => {
	it("stores and retrieves values", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("missing")).toBeUndefined();
		expect(cache.has("a")).toBe(true);
	});
	it("never holds more than capacity entries", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		expect(cache.size).toBe(2);
	});
	it("evicts the least recently inserted entry first", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		expect(cache.has("a")).toBe(false);
		expect(cache.has("b")).toBe(true);
		expect(cache.has("c")).toBe(true);
	});
	it("get refreshes recency", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
	});
	it("overwriting a key does not grow the cache", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("a", 2);
		expect(cache.size).toBe(1);
		expect(cache.get("a")).toBe(2);
	});
	it("delete removes an entry", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		expect(cache.delete("a")).toBe(true);
		expect(cache.delete("a")).toBe(false);
		expect(cache.size).toBe(0);
	});
	it("rejects a non-positive capacity", () => {
		expect(() => new LruCache(0)).toThrow(RangeError);
	});
});
