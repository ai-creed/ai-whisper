import type { BrokerEventMap, BrokerEventName } from "./broker-event-bus.js";

// The event-socket wire protocol version. Bump ONLY on a breaking change to
// framing, the hello frame, or event-frame shape. Adding new event names is
// non-breaking and must NOT bump this. Consumers refuse a mismatched hello and
// fall back to DB polling. A STRING by contract (consumers validate "1", not 1).
export const EVENT_PROTOCOL_VERSION = "1";

// Sent once, immediately, when a client connects.
export interface HelloFrame {
	type: "hello";
	engineVersion: string;
	protocolVersion: string;
}

// One per BrokerEventBus emission. `payload` is the bus payload verbatim; `ts`
// is an ISO-8601 timestamp stamped at fanout time. Consumers treat frames as
// wake-up signals only ("re-read the DB now") — payload richness is not
// contractual beyond these shapes.
export interface EventFrame<E extends BrokerEventName = BrokerEventName> {
	type: "event";
	name: E;
	payload: BrokerEventMap[E];
	ts: string;
}

export type EventSocketFrame = HelloFrame | EventFrame;
