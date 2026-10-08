import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler.ts";

describe("Scheduler", () => {
	it("runs jobs sequentially in insertion order", async () => {
		const events: string[] = [];
		const scheduler = new Scheduler();
		for (const name of ["a", "b", "c"]) {
			scheduler.add(name, async () => {
				events.push(`${name}:start`);
				await Promise.resolve();
				events.push(`${name}:end`);
			});
		}
		await scheduler.runAll();
		expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
	});

	it("captures failures and keeps running later jobs", async () => {
		const scheduler = new Scheduler();
		scheduler.add("a", async () => {});
		scheduler.add("b", async () => {
			throw new Error("boom");
		});
		scheduler.add("c", async () => {});
		expect(await scheduler.runAll()).toEqual({ a: "done", b: "failed", c: "done" });
	});

	it("rejects duplicate job names", () => {
		const scheduler = new Scheduler();
		scheduler.add("a", async () => {});
		expect(() => scheduler.add("a", async () => {})).toThrow("duplicate job a");
	});

	it("resolves an empty result when nothing was added", async () => {
		expect(await new Scheduler().runAll()).toEqual({});
	});
});
