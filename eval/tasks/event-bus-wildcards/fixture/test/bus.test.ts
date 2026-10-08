import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/bus.ts";

describe("EventBus", () => {
	it("delivers payload and topic to exact subscribers", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("order.created", handler);
		bus.emit("order.created", { id: 1 });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ id: 1 }, "order.created");
	});
	it("does not deliver other topics", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("order.created", handler);
		bus.emit("order.deleted", null);
		expect(handler).not.toHaveBeenCalled();
	});
	it("calls every subscriber of a topic in registration order", () => {
		const bus = new EventBus();
		const calls: string[] = [];
		bus.on("t", () => calls.push("first"));
		bus.on("t", () => calls.push("second"));
		bus.emit("t", undefined);
		expect(calls).toEqual(["first", "second"]);
	});
	it("off removes a subscriber", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("t", handler);
		bus.off("t", handler);
		bus.emit("t", 1);
		expect(handler).not.toHaveBeenCalled();
	});
	it("on returns an unsubscribe function", () => {
		const bus = new EventBus();
		const handler = vi.fn();
		const unsubscribe = bus.on("t", handler);
		unsubscribe();
		bus.emit("t", 1);
		expect(handler).not.toHaveBeenCalled();
	});
	it("emitting a topic nobody listens to is a no-op", () => {
		expect(() => new EventBus().emit("nobody", 1)).not.toThrow();
	});
});
