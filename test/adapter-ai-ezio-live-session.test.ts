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

	it("renders assistant_delta to onProviderOutput", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		const out: string[] = [];
		live.onProviderOutput?.((d) => out.push(d));
		await live.start();
		f.emit({ type: "assistant_delta", turnId: "t", text: "hello" });
		expect(out.join("")).toContain("hello");
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

describe("createAiEzioLiveSession — REPL-look rendering (M7)", () => {
	function capturing() {
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		return { writes, stdout, out: () => writes.join("") };
	}

	it("renders a banner on status and a usage line + prompt after a turn", async () => {
		const f = fakeEngine();
		const cap = capturing();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: cap.stdout });
		await live.start();
		f.emit({ type: "status", model: "gpt-5.5", provider: "codex", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "high" });
		f.emit({ type: "assistant_delta", turnId: "t", text: "hello" });
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "hello", usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 } });
		f.emit({ type: "idle" });
		const out = cap.out();
		expect(out).toContain("ezio"); // banner
		expect(out).toContain("codex");
		expect(out).toContain("gpt-5.5");
		expect(out).toContain("high");
		expect(out).toMatch(/context 8\.7k \/ 256k \(3%\)/); // usage line (binary k, mirrors hax)
		expect(out).toContain("out 595");
		expect(out).toContain("cached 2.6k");
		// banner › + post-turn prompt › → >= 2 (not satisfiable by the banner alone)
		expect((out.match(/›/g) || []).length).toBeGreaterThanOrEqual(2);
	});

	it("omits the effort segment when empty and skips unreported usage fields", async () => {
		const f = fakeEngine();
		const cap = capturing();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: cap.stdout });
		await live.start();
		f.emit({ type: "status", model: "m", provider: "p", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "" });
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "x" }); // no usage
		f.emit({ type: "idle" });
		const out = cap.out();
		expect(out).toContain("p");
		expect(out).not.toMatch(/· · /); // no empty effort segment
		expect(out).not.toContain("context "); // no usage line when usage absent
		// The banner contains one ›; a POST-TURN prompt must add another. Count >= 2
		// so a regression dropping the prompt when usage is absent fails.
		expect((out.match(/›/g) || []).length).toBeGreaterThanOrEqual(2);
	});

	it("renders the banner only once across repeated status events", async () => {
		const f = fakeEngine();
		const cap = capturing();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: cap.stdout });
		await live.start();
		const status = { type: "status", model: "gpt-5.5", provider: "codex", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "high" } as const;
		f.emit(status); // auto-status on ready
		f.emit(status); // a later M4 status control must NOT re-render the banner
		expect((cap.out().match(/ezio/g) || []).length).toBe(1);
	});
});
