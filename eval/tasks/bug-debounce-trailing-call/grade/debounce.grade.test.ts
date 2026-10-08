import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "../src/debounce.ts";

describe("debounce (held-out)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function timers() {
		return { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
	}

	it("trailing uses latest args", () => {
		const calls: number[][] = [];
		const d = debounce((...a: number[]) => calls.push(a), 100, { leading: true, trailing: true, ...timers() });
		d(1);
		d(2);
		d(3);
		expect(calls).toEqual([[1]]);
		vi.advanceTimersByTime(100);
		expect(calls).toEqual([[1], [3]]);
	});
	it("single call leading+trailing invokes once", () => {
		const calls: number[][] = [];
		const d = debounce((...a: number[]) => calls.push(a), 100, { leading: true, trailing: true, ...timers() });
		d(1);
		vi.advanceTimersByTime(1000);
		expect(calls).toEqual([[1]]);
	});
	it("cancel then flush no-op", () => {
		const calls: number[][] = [];
		const d = debounce((...a: number[]) => calls.push(a), 100, timers());
		d(1);
		d.cancel();
		d.flush();
		vi.advanceTimersByTime(1000);
		expect(calls).toEqual([]);
	});
	it("flush invokes pending with latest args", () => {
		const calls: number[][] = [];
		const d = debounce((...a: number[]) => calls.push(a), 100, { leading: true, trailing: true, ...timers() });
		d(1);
		d(2);
		d(3);
		d.flush();
		expect(calls).toEqual([[1], [3]]);
		vi.advanceTimersByTime(1000);
		expect(calls).toEqual([[1], [3]]);
	});
	it("re-entrant call during leading is queued", () => {
		const calls: number[][] = [];
		const d = debounce(
			(...a: number[]) => {
				calls.push(a);
				if (a[0] === 1) d(99);
			},
			100,
			{ leading: true, trailing: true, ...timers() },
		);
		d(1);
		expect(calls).toEqual([[1]]);
		vi.advanceTimersByTime(100);
		expect(calls).toEqual([[1], [99]]);
	});
	it("trailing-only still works", () => {
		const calls: number[][] = [];
		const d = debounce((...a: number[]) => calls.push(a), 100, timers());
		d(1);
		d(2);
		expect(calls).toEqual([]);
		vi.advanceTimersByTime(100);
		expect(calls).toEqual([[2]]);
	});
	it("leading-only still works", () => {
		const calls: number[][] = [];
		const d = debounce((...a: number[]) => calls.push(a), 100, { leading: true, trailing: false, ...timers() });
		d(1);
		d(2);
		expect(calls).toEqual([[1]]);
		vi.advanceTimersByTime(100);
		expect(calls).toEqual([[1]]);
		d(3);
		expect(calls).toEqual([[1], [3]]);
	});
});
