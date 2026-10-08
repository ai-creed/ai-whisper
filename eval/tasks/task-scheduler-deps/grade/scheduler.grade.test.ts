import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler.ts";

// Awaiting a few microtask turns lets sibling jobs overlap without any wall-clock time.
async function ticks(n: number): Promise<void> {
	for (let i = 0; i < n; i++) await Promise.resolve();
}

const noop = async (): Promise<void> => {};

describe("task-scheduler-deps (held-out)", () => {
	it("deps run before their dependents", async () => {
		const events: string[] = [];
		const job = (name: string, n: number) => async () => {
			events.push(`${name}:start`);
			await ticks(n);
			events.push(`${name}:end`);
		};
		const scheduler = new Scheduler();
		scheduler.add("a", job("a", 5));
		scheduler.add("c", job("c", 1));
		scheduler.add("b", job("b", 1), { deps: ["a"] });
		const results = await scheduler.runAll({ concurrency: 3 });
		expect(results).toEqual({ a: "done", c: "done", b: "done" });
		expect(events.indexOf("a:end")).toBeLessThan(events.indexOf("b:start"));
		expect(events.indexOf("c:start")).toBeLessThan(events.indexOf("a:end"));
	});

	it("independent jobs run concurrently up to the limit", async () => {
		let inFlight = 0;
		let max = 0;
		const scheduler = new Scheduler();
		for (let i = 0; i < 6; i++) {
			scheduler.add(`j${i}`, async () => {
				inFlight++;
				max = Math.max(max, inFlight);
				await ticks(4);
				inFlight--;
			});
		}
		const results = await scheduler.runAll({ concurrency: 2 });
		expect(Object.values(results)).toEqual(Array(6).fill("done"));
		expect(max).toBe(2);
	});

	it("a failed dep skips its dependents transitively", async () => {
		const ran: string[] = [];
		const scheduler = new Scheduler();
		scheduler.add("a", async () => {
			ran.push("a");
			throw new Error("boom");
		});
		scheduler.add("b", async () => void ran.push("b"), { deps: ["a"] });
		scheduler.add("c", async () => void ran.push("c"), { deps: ["b"] });
		scheduler.add("d", async () => void ran.push("d"));
		expect(await scheduler.runAll()).toEqual({ a: "failed", b: "skipped", c: "skipped", d: "done" });
		expect(ran).toEqual(["a", "d"]);
	});

	it("retries re-run a failing job up to N extra times", async () => {
		let calls = 0;
		const flaky = new Scheduler();
		flaky.add(
			"flaky",
			async () => {
				calls++;
				if (calls < 3) throw new Error("not yet");
			},
			{ retries: 2 },
		);
		expect(await flaky.runAll()).toEqual({ flaky: "done" });
		expect(calls).toBe(3);

		let attempts = 0;
		const broken = new Scheduler();
		broken.add(
			"broken",
			async () => {
				attempts++;
				throw new Error("always");
			},
			{ retries: 2 },
		);
		expect(await broken.runAll()).toEqual({ broken: "failed" });
		expect(attempts).toBe(3);
	});

	it("a cycle is detected at runAll and the error names the cycle path", async () => {
		const ran: string[] = [];
		const scheduler = new Scheduler();
		scheduler.add("a", async () => void ran.push("a"));
		scheduler.add("b", async () => void ran.push("b"), { deps: ["a"] });
		scheduler.addDependency("a", "b");
		await expect(scheduler.runAll()).rejects.toThrow(new Error("cycle: a -> b -> a"));
		expect(ran).toEqual([]);
	});

	it("an unknown dep throws at add", () => {
		const scheduler = new Scheduler();
		expect(() => scheduler.add("a", noop, { deps: ["x"] })).toThrow("unknown dependency x");
	});

	it("a diamond graph runs the shared root once", async () => {
		const counts: Record<string, number> = {};
		const order: string[] = [];
		let inFlight = 0;
		let max = 0;
		const job = (name: string) => async () => {
			counts[name] = (counts[name] ?? 0) + 1;
			order.push(name);
			inFlight++;
			max = Math.max(max, inFlight);
			await ticks(2);
			inFlight--;
		};
		const scheduler = new Scheduler();
		scheduler.add("root", job("root"));
		scheduler.add("left", job("left"), { deps: ["root"] });
		scheduler.add("right", job("right"), { deps: ["root"] });
		scheduler.add("tip", job("tip"), { deps: ["left", "right"] });
		expect(await scheduler.runAll({ concurrency: 4 })).toEqual({ root: "done", left: "done", right: "done", tip: "done" });
		expect(counts).toEqual({ root: 1, left: 1, right: 1, tip: 1 });
		expect(order[0]).toBe("root");
		expect(order[3]).toBe("tip");
		expect(max).toBe(2);
	});

	it("an empty scheduler resolves {}", async () => {
		expect(await new Scheduler().runAll()).toEqual({});
		expect(await new Scheduler().runAll({ concurrency: 3 })).toEqual({});
	});

	it("jobs without options behave as before", async () => {
		const events: string[] = [];
		const scheduler = new Scheduler();
		scheduler.add("a", async () => void events.push("a"));
		scheduler.add("b", async () => {
			events.push("b");
			throw new Error("boom");
		});
		scheduler.add("c", async () => void events.push("c"));
		expect(await scheduler.runAll()).toEqual({ a: "done", b: "failed", c: "done" });
		expect(events).toEqual(["a", "b", "c"]);
		expect(() => scheduler.add("a", noop)).toThrow("duplicate job a");
	});
});
