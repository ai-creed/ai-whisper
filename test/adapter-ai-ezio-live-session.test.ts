import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";
import { writeFileSync } from "node:fs";

function fakeEngine() {
	let onEvent: (e: ProtocolEvent) => void = () => {};
	const submit = vi.fn();
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		transcriptPath: undefined,
		newConversation: vi.fn(async () => {}),
		status: vi.fn(async () => ({ provider: "mock", model: "mock" })),
		submit,
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
		registerDelegatedTools: vi.fn(),
		sendToolResult: vi.fn(),
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
		const live = createAiEzioLiveSession({ createEngineSession: f.create, buildAutoCompact: () => null,stdout: { write: vi.fn() } as never });
		await live.start();
		live.writeUserInput("do the thing");
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(f.submit).toHaveBeenCalledWith("do the thing");
	});

	it("forwards assistant_delta to onProviderOutput but suppresses it from the pane", async () => {
		const f = fakeEngine();
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		const live = createAiEzioLiveSession({ createEngineSession: f.create, buildAutoCompact: () => null,stdout });
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
		const live = createAiEzioLiveSession({ createEngineSession: f.create, buildAutoCompact: () => null,stdout: { write: vi.fn() } as never });
		const finished: string[] = [];
		live.onTurnFinished?.((content) => finished.push(content));
		await live.start();
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "final answer" });
		f.emit({ type: "idle" });
		expect(finished).toEqual(["final answer"]);
	});

	it("does not fire onTurnFinished on the startup idle (no turn yet)", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, buildAutoCompact: () => null,stdout: { write: vi.fn() } as never });
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
		const live = createAiEzioLiveSession({ createEngineSession: f.create, buildAutoCompact: () => null,stdout: cap.stdout });
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
		const live = createAiEzioLiveSession({ createEngineSession: f.create, buildAutoCompact: () => null,stdout });
		live.onTurnFinished?.(() => order.push("handback"));
		await live.start();
		// Use a clean, completed-answer content: the §4.3 shape guard now defers
		// drafting/empty fragments, so the timing fixture must be a real handback.
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "the task is done" });
		f.emit({ type: "idle" });
		expect(order).toEqual(["handback", "prompt"]);
	});
});

// Mounted slash commands: ezio handles `/`-commands locally (rendered to the
// pane) and never submits them to the engine. The controller is built in
// start() from a mounted SlashController; tryConsumeLocalCommand returns true
// for any command line (handled/unknown) and false for ordinary text.
describe("createAiEzioLiveSession — mounted slash commands", () => {
	function harness() {
		let onEvent: (e: ProtocolEvent) => void = () => {};
		const submits: string[] = [];
		const writes: string[] = [];
		const copied: string[] = [];
		const session: AiEzioEngineSession = {
			start: vi.fn(async (opts?: { transcriptPath?: string }) => {
				session.transcriptPath = opts?.transcriptPath ?? "";
				return { type: "ready" };
			}),
			transcriptPath: undefined,
			newConversation: vi.fn(async () => {}),
			status: vi.fn(async () => ({ provider: "mock", model: "mock" })),
			submit: vi.fn((text: string) => {
				submits.push(text);
			}),
			interrupt: vi.fn(),
			submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
			registerDelegatedTools: vi.fn(),
			sendToolResult: vi.fn(),
			onExit: vi.fn(),
			close: vi.fn(),
		};
		const controller = createAiEzioLiveSession({
			createEngineSession: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
				onEvent = opts.onEvent;
				return session;
			},
			mcpHost: {
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
				handleEvent: vi.fn(),
			} as never,
			buildAutoCompact: () => null,
			clipboard: async (text: string) => {
				copied.push(text);
			},
			stdout: { write: (s: string) => (writes.push(s), true) } as never,
		});
		return {
			controller,
			fire: (e: ProtocolEvent) => onEvent(e),
			writes,
			submits,
			copied,
			session,
		};
	}

	it("tracks the last assistant turn for /usage and /copy", async () => {
		const h = harness();
		await h.controller.start();
		h.fire({
			type: "assistant_turn_finished",
			turnId: "t",
			content: "hello",
			usage: { outputTokens: 7 },
		});
		expect(await h.controller.tryConsumeLocalCommand?.("/usage")).toBe(true);
		expect(h.writes.join("")).toContain("output 7");
		expect(h.writes.join("")).not.toContain("no usage yet");
		expect(await h.controller.tryConsumeLocalCommand?.("/copy")).toBe(true);
		expect(h.copied).toContain("hello");
	});

	it("consumes a known command (/help) without submitting", async () => {
		const h = harness();
		await h.controller.start();
		expect(await h.controller.tryConsumeLocalCommand?.("/help")).toBe(true);
		expect(h.writes.join("")).toContain("/help");
		expect(h.submits).toHaveLength(0);
	});

	it("does not consume ordinary text", async () => {
		const h = harness();
		await h.controller.start();
		expect(await h.controller.tryConsumeLocalCommand?.("hello world")).toBe(false);
		expect(h.submits).toHaveLength(0);
	});

	it("excludes /quit and /exit (mounted owns the lifecycle)", async () => {
		const h = harness();
		await h.controller.start();
		expect(await h.controller.tryConsumeLocalCommand?.("/quit")).toBe(true);
		expect(await h.controller.tryConsumeLocalCommand?.("/exit")).toBe(true);
		expect(h.writes.join("")).toContain("unknown command: /quit");
		expect(h.writes.join("")).toContain("unknown command: /exit");
	});

	it("dumps the minted transcript on /transcript", async () => {
		const h = harness();
		await h.controller.start();
		expect(h.session.transcriptPath).toMatch(/ezio-mounted-.*\.txt$/);
		writeFileSync(h.session.transcriptPath as string, "TRANSCRIPT_BODY");
		expect(await h.controller.tryConsumeLocalCommand?.("/transcript")).toBe(true);
		expect(h.writes.join("")).toContain("TRANSCRIPT_BODY");
	});
});
