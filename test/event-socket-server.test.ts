import { describe, expect, it } from "vitest";
import {
	EVENT_PROTOCOL_VERSION,
	type EventSocketFrame,
} from "../packages/broker/src/runtime/event-protocol.ts";

describe("event-protocol constant", () => {
	it("pins the wire protocol version to the string \"1\"", () => {
		expect(EVENT_PROTOCOL_VERSION).toBe("1");
		// Contractual: it is a STRING, not a number (consumer validates with zod).
		expect(typeof EVENT_PROTOCOL_VERSION).toBe("string");
	});

	it("is re-exported from the broker package index", async () => {
		const broker = await import("../packages/broker/src/index.ts");
		expect(broker.EVENT_PROTOCOL_VERSION).toBe("1");
	});

	it("frame types discriminate on `type`", () => {
		const hello: EventSocketFrame = {
			type: "hello",
			engineVersion: "0.5.8",
			protocolVersion: EVENT_PROTOCOL_VERSION,
		};
		expect(hello.type).toBe("hello");
	});
});
