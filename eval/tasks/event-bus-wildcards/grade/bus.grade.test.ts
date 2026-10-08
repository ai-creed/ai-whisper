import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/bus.ts";

describe("EventBus wildcards (held-out)", () => {
	it("single star matches one segment", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("order.*", handler);
		bus.emit("order.created", 1);
		expect(handler).toHaveBeenCalledTimes(1);
	});
	it("single star does not match two segments", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("order.*", handler);
		bus.emit("order.item.added", 1);
		bus.emit("order", 1);
		expect(handler).not.toHaveBeenCalled();
		bus.emit("order.created", 1);
		expect(handler).toHaveBeenCalledTimes(1);
	});
	it("double star matches one or more trailing", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("order.**", handler);
		bus.emit("order.created", 1);
		bus.emit("order.item.added", 2);
		bus.emit("order", 3);
		expect(handler).toHaveBeenCalledTimes(2);
	});
	it("handler receives concrete topic", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("order.*", handler);
		bus.emit("order.created", { id: 7 });
		expect(handler).toHaveBeenCalledWith({ id: 7 }, "order.created");
	});
	it("exact before wildcard order", () => {
		const bus = new EventBus();
		const calls: string[] = [];
		bus.on("order.*", () => calls.push("star"));
		bus.on("order.**", () => calls.push("doublestar"));
		bus.on("order.created", () => calls.push("exact"));
		bus.emit("order.created", null);
		expect(calls).toEqual(["exact", "star", "doublestar"]);
	});
	it("once fires once even when throwing", () => {
		const bus = new EventBus();
		const handler = vi.fn(() => {
			throw new Error("boom");
		});
		bus.once("a.b", handler);
		expect(() => bus.emit("a.b", 1)).toThrow("boom");
		expect(() => bus.emit("a.b", 2)).not.toThrow();
		expect(handler).toHaveBeenCalledTimes(1);
	});
	it("off removes wildcard subscription", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("a.*", handler);
		bus.emit("a.b", 1);
		expect(handler).toHaveBeenCalledTimes(1);
		bus.off("a.*", handler);
		bus.emit("a.b", 2);
		expect(handler).toHaveBeenCalledTimes(1);
	});
	it("self-unsubscribe during emit does not skip others", () => {
		const bus = new EventBus();
		const calls: string[] = [];
		const unsubscribe = bus.on("a.*", () => {
			calls.push("first");
			unsubscribe();
		});
		bus.on("a.*", () => calls.push("second"));
		bus.on("a.**", () => calls.push("third"));
		bus.emit("a.b", null);
		expect(calls).toEqual(["first", "second", "third"]);
		bus.emit("a.b", null);
		expect(calls).toEqual(["first", "second", "third", "second", "third"]);
	});
});
