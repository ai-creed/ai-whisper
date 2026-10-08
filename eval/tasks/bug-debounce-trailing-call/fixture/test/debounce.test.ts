import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "../src/debounce.ts";

describe("debounce", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("trailing only (default)", () => {
		it("waits for the quiet period before invoking", () => {
			const fn = vi.fn();
			const d = debounce(fn, 100);
			d(1);
			vi.advanceTimersByTime(99);
			expect(fn).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(fn).toHaveBeenCalledWith(1);
		});
		it("restarts the wait on every call and uses the latest args", () => {
			const fn = vi.fn();
			const d = debounce(fn, 100);
			d(1);
			vi.advanceTimersByTime(60);
			d(2);
			vi.advanceTimersByTime(60);
			expect(fn).not.toHaveBeenCalled();
			vi.advanceTimersByTime(40);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(fn).toHaveBeenCalledWith(2);
		});
		it("cancel drops the pending call", () => {
			const fn = vi.fn();
			const d = debounce(fn, 100);
			d(1);
			d.cancel();
			vi.advanceTimersByTime(500);
			expect(fn).not.toHaveBeenCalled();
		});
	});

	describe("leading only", () => {
		it("invokes immediately and ignores calls inside the window", () => {
			const fn = vi.fn();
			const d = debounce(fn, 100, { leading: true, trailing: false });
			d(1);
			expect(fn).toHaveBeenCalledTimes(1);
			d(2);
			vi.advanceTimersByTime(100);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(fn).toHaveBeenCalledWith(1);
		});
		it("invokes again after the window has passed", () => {
			const fn = vi.fn();
			const d = debounce(fn, 100, { leading: true, trailing: false });
			d(1);
			vi.advanceTimersByTime(100);
			d(2);
			expect(fn).toHaveBeenCalledTimes(2);
			expect(fn).toHaveBeenLastCalledWith(2);
		});
	});
});
