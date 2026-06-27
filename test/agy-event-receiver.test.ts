import { describe, expect, it } from "vitest";
import { AgyEventReceiver } from "../packages/cli/src/runtime/agy-event-receiver.ts";

const PARENT = "parent-conv";
const SUB = "subagent-conv";

function stop(conversationId: string, fullyIdle: boolean, workspacePaths: string[] = []): string {
	return JSON.stringify({
		conversationId,
		fullyIdle,
		terminationReason: "NO_TOOL_CALL",
		transcriptPath: "/t.jsonl",
		workspacePaths,
	});
}
function tool(conversationId: string, stepIdx: number, workspacePaths: string[] = []): string {
	return JSON.stringify({
		conversationId,
		stepIdx,
		toolCall: { name: "run_command", args: {} },
		workspacePaths,
	});
}
function invocation(conversationId: string, workspacePaths: string[] = []): string {
	return JSON.stringify({ conversationId, invocationNum: 1, workspacePaths });
}

describe("AgyEventReceiver — pinned mode", () => {
	const make = () => new AgyEventReceiver({ mode: "pinned", mountCwd: "/ws", pinnedConversationId: PARENT });

	it("emits a turn-end for the parent Stop with fullyIdle:true", () => {
		const r = make();
		const obs = r.observe(stop(PARENT, true), "2026-06-27T00:00:00.000Z", "Stop");
		expect(obs.kind).toBe("turn-end");
		if (obs.kind === "turn-end") {
			expect(obs.event.provider).toBe("agy");
			expect(obs.event.sessionOrThreadId).toBe(PARENT);
			expect(obs.event.cwd).toBe("/ws");
			expect(obs.event.inputMessages).toEqual([]);
			expect(obs.event.receivedAt).toBe("2026-06-27T00:00:00.000Z");
		}
	});

	it("does NOT emit a turn-end for the parent's fullyIdle:false pause", () => {
		expect(make().observe(stop(PARENT, false), "t", "Stop").kind).toBe("heartbeat");
	});

	it("ignores a subagent Stop (different conversationId)", () => {
		expect(make().observe(stop(SUB, true), "t", "Stop").kind).toBe("ignored");
	});

	it("treats PreInvocation/PostInvocation as heartbeats", () => {
		const r = make();
		expect(r.observe(invocation(PARENT), "t", "PreInvocation").kind).toBe("heartbeat");
		expect(r.observe(invocation(PARENT), "t", "PostInvocation").kind).toBe("heartbeat");
	});

	it("brackets a tool: PreToolUse opens, matching PostToolUse closes", () => {
		const r = make();
		const open = r.observe(tool(PARENT, 6), "t", "PreToolUse");
		expect(open).toEqual({ kind: "heartbeat", toolInFlight: true });
		const close = r.observe(tool(PARENT, 6), "t", "PostToolUse");
		expect(close).toEqual({ kind: "heartbeat", toolInFlight: false });
	});

	it("keeps toolInFlight true until the matching stepIdx closes", () => {
		const r = make();
		r.observe(tool(PARENT, 6), "t", "PreToolUse");
		expect(r.observe(tool(PARENT, 7), "t", "PreToolUse")).toEqual({ kind: "heartbeat", toolInFlight: true });
		expect(r.observe(tool(PARENT, 6), "t", "PostToolUse")).toEqual({ kind: "heartbeat", toolInFlight: true });
		expect(r.observe(tool(PARENT, 7), "t", "PostToolUse")).toEqual({ kind: "heartbeat", toolInFlight: false });
	});

	it("treats a PostToolUse for an unopened stepIdx as a harmless no-op", () => {
		// agy fires some PostToolUse events for steps that never had a matching
		// PreToolUse (observed in the smoke probe as `tool=None` steps). Deleting an
		// absent stepIdx must not throw and must leave toolInFlight false.
		const r = make();
		expect(r.observe(tool(PARENT, 1), "t", "PostToolUse")).toEqual({
			kind: "heartbeat",
			toolInFlight: false,
		});
		// A real bracket still tracks correctly afterwards.
		expect(r.observe(tool(PARENT, 6), "t", "PreToolUse")).toEqual({
			kind: "heartbeat",
			toolInFlight: true,
		});
		expect(r.observe(tool(PARENT, 6), "t", "PostToolUse")).toEqual({
			kind: "heartbeat",
			toolInFlight: false,
		});
	});

	it("returns ignored for malformed JSON", () => {
		expect(make().observe("{not json", "t", "Stop").kind).toBe("ignored");
	});
});

describe("AgyEventReceiver — workspace mode (first event is ours)", () => {
	it("adopts the first event's conversationId, then gates on it", () => {
		const r = new AgyEventReceiver({ mode: "workspace", mountCwd: "/ws" });
		// First event adopts PARENT (no Stop yet → heartbeat).
		expect(r.observe(invocation(PARENT), "t", "PreInvocation").kind).toBe("heartbeat");
		// A foreign Stop after adoption is ignored.
		expect(r.observe(stop(SUB, true), "t", "Stop").kind).toBe("ignored");
		// The parent's gated Stop is the turn-end.
		expect(r.observe(stop(PARENT, true), "t", "Stop").kind).toBe("turn-end");
	});
});

describe("AgyEventReceiver — global mode (workspacePaths discriminator)", () => {
	it("adopts only an event whose workspacePaths contains the mount cwd", () => {
		const r = new AgyEventReceiver({ mode: "global", mountCwd: "/ws" });
		// Unrelated session fires FIRST with empty workspacePaths → never adopted.
		expect(r.observe(stop(SUB, true, []), "t", "Stop").kind).toBe("ignored");
		// Our session's event carries the workspace path → adopt PARENT.
		expect(r.observe(invocation(PARENT, ["/ws"]), "t", "PreInvocation").kind).toBe("heartbeat");
		// Now the unrelated Stop is still ignored and the parent Stop is the turn-end.
		expect(r.observe(stop(SUB, true, []), "t", "Stop").kind).toBe("ignored");
		expect(r.observe(stop(PARENT, true, ["/ws"]), "t", "Stop").kind).toBe("turn-end");
	});

	it("adopts nothing (degrade to idle) when no event ever matches the cwd", () => {
		const r = new AgyEventReceiver({ mode: "global", mountCwd: "/ws" });
		expect(r.observe(stop(SUB, true, []), "t", "Stop").kind).toBe("ignored");
		expect(r.observe(invocation(SUB, ["/other"]), "t", "PreInvocation").kind).toBe("ignored");
		expect(r.observe(stop(SUB, true, ["/other"]), "t", "Stop").kind).toBe("ignored");
	});
});
