import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";

function fakeEngine() {
	let onEvent: (e: ProtocolEvent) => void = () => {};
	const submit = vi.fn();
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		submit,
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
		onExit: vi.fn(),
		close: vi.fn(),
	};
	return {
		create: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
			onEvent = opts.onEvent;
			return session;
		},
		emit: (e: ProtocolEvent) => onEvent(e),
		session,
		submit,
	};
}

describe("createAiEzioLiveSession", () => {
	it("writeUserInput submits over the protocol (single submit, no keystrokes)", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		await live.start();
		live.writeUserInput("do the thing");
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(f.submit).toHaveBeenCalledWith("do the thing");
	});

	it("forwards assistant_delta to onProviderOutput but suppresses it from the pane", async () => {
		const f = fakeEngine();
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout });
		const out: string[] = [];
		live.onProviderOutput?.((d) => out.push(d));
		await live.start();
		f.emit({ type: "assistant_delta", turnId: "t", text: "hello" });
		// Relay capture still sees the raw delta…
		expect(out.join("")).toContain("hello");
		// …but the pane stays silent — markdown is rendered from the final content.
		expect(writes.join("")).toBe("");
	});

	it("fires onTurnFinished with the authoritative content on idle", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		const finished: string[] = [];
		live.onTurnFinished?.((content) => finished.push(content));
		await live.start();
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "final answer" });
		f.emit({ type: "idle" });
		expect(finished).toEqual(["final answer"]);
	});

	it("does not fire onTurnFinished on the startup idle (no turn yet)", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		const finished: string[] = [];
		live.onTurnFinished?.((content) => finished.push(content));
		await live.start();
		f.emit({ type: "idle" });
		expect(finished).toEqual([]);
	});
});

// M8: the live-session no longer renders the pane itself — it delegates every
// byte of display to the mounted renderer (now @ai-ezio/surface, unit-tested in
// that package's mounted-renderer.test). These tests assert the SEAM: events
// reach the renderer (banner on status, a usage line + prompt after a turn) and
// the handback still fires before the renderer draws the prompt. Detailed look
// (binary-k usage, ❯ prompt parity, markdown, tool diffs) is covered by
// @ai-ezio/surface's mounted-renderer.test.ts.
describe("createAiEzioLiveSession — delegates display to the mounted renderer (M8)", () => {
	function capturing() {
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		return { writes, stdout, out: () => writes.join("") };
	}

	it("drives the renderer: banner on status, usage line + prompt after a turn", async () => {
		const f = fakeEngine();
		const cap = capturing();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: cap.stdout });
		await live.start();
		f.emit({ type: "status", model: "gpt-5.5", provider: "codex", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "high" });
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "hello", usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 } });
		f.emit({ type: "idle" });
		const out = cap.out();
		expect(out).toContain("ezio"); // banner
		expect(out).toContain("codex");
		expect(out).toContain("gpt-5.5");
		expect(out).toContain("high");
		expect(out).toMatch(/context 8\.7k \/ 256k \(3%\)/); // usage line (renderer)
		expect(out).toContain("❯"); // post-turn prompt (renderer)
	});

	it("fires the handback BEFORE the renderer draws the prompt (M6 timing)", async () => {
		const f = fakeEngine();
		const order: string[] = [];
		const stdout = {
			write: (s: string) => {
				if (s.includes("❯")) order.push("prompt");
				return true;
			},
		} as never;
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout });
		live.onTurnFinished?.(() => order.push("handback"));
		await live.start();
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "done" });
		f.emit({ type: "idle" });
		expect(order).toEqual(["handback", "prompt"]);
	});
});
