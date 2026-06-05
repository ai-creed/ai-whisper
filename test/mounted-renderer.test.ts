import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createMountedRenderer } from "../packages/adapter-ai-ezio/src/mounted-renderer.ts";

function setup(opts?: { utf8?: boolean }) {
	const writes: string[] = [];
	const stdout = { write: (s: string) => (writes.push(s), true) } as never;
	let cb: (() => void) | null = null;
	const set = vi.fn((fn: () => void) => {
		cb = fn;
		return 1 as never;
	});
	const clear = vi.fn();
	const r = createMountedRenderer({
		stdout,
		utf8: opts?.utf8 ?? true,
		setInterval: set,
		clearInterval: clear,
	});
	return { r, out: () => writes.join(""), writes, set, clear, tick: () => cb?.() };
}

const STATUS: ProtocolEvent = {
	type: "status",
	model: "gpt-5.5",
	provider: "codex",
	protocol: "0.1.0",
	sessionId: "s",
	state: "idle",
	effort: "high",
};

describe("createMountedRenderer", () => {
	it("renders the banner exactly once across repeated status events", () => {
		const t = setup();
		t.r.handle(STATUS);
		t.r.handle(STATUS);
		expect((t.out().match(/ezio/g) || []).length).toBe(1);
		expect(t.out()).toContain("codex");
		expect(t.out()).toContain("gpt-5.5");
		expect(t.out()).toContain("high");
	});

	it("no-raw-delta: an assistant_delta writes nothing to the pane", () => {
		const t = setup();
		t.r.handle({ type: "assistant_delta", turnId: "t", text: "hello" });
		expect(t.out()).toBe("");
	});

	it("renders the final content as markdown at turn end", () => {
		const t = setup();
		t.r.handle({ type: "assistant_turn_finished", turnId: "t", content: "**hi**" });
		t.r.handle({ type: "idle" });
		expect(t.out()).toContain("\u001b[1mhi\u001b[0m"); // bold-rendered markdown
	});

	it("spinner: shown after user_turn_started, cleared on first output", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t" });
		expect(t.set).toHaveBeenCalled();
		expect(t.out()).toContain("thinking");
		t.r.handle({ type: "assistant_turn_finished", turnId: "t", content: "done" });
		expect(t.clear).toHaveBeenCalled();
		expect(t.out()).toContain("\r"); // clear-line carriage return
	});

	it("spinner idle-safety: timer cleared on idle, no frame after idle", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t" });
		t.r.handle({ type: "idle" });
		expect(t.clear).toHaveBeenCalled();
		const before = t.out().length;
		t.tick(); // invoke the captured interval callback AFTER idle
		expect(t.out().length).toBe(before); // no spinner frame written post-idle
	});

	it("tool: renders ⏺ name · args, a colored diff, a dim preview, and error status", () => {
		const t = setup();
		t.r.handle({ type: "tool_call_started", turnId: "t", name: "bash", callId: "c", args: "ls -la" });
		expect(t.out()).toContain("⏺");
		expect(t.out()).toContain("bash");
		expect(t.out()).toContain("ls -la");

		const d = setup();
		d.r.handle({ type: "tool_call_finished", turnId: "t", name: "edit", callId: "c", status: "ok", output: "--- a\n+++ b\n+added\n-removed\n", isDiff: true });
		expect(d.out()).toContain("[32m"); // green + line
		expect(d.out()).toContain("[31m"); // red - line

		const p = setup();
		p.r.handle({ type: "tool_call_finished", turnId: "t", name: "bash", callId: "c", status: "ok", output: "l1\nl2\nl3\nl4\nl5\nl6\n", isDiff: false });
		expect(p.out()).toContain("[2m"); // dim preview
		expect(p.out()).toContain("l1");

		const e = setup();
		e.r.handle({ type: "tool_call_finished", turnId: "t", name: "bash", callId: "c", status: "error", output: "boom", isDiff: false });
		expect(e.out()).toContain("[31m"); // red error status
	});

	it("usage line begins on its own line (M7 glue-bug fix)", () => {
		const t = setup();
		t.r.handle({
			type: "assistant_turn_finished",
			turnId: "t",
			content: "answer",
			usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 },
		});
		t.r.handle({ type: "idle" });
		const out = t.out();
		expect(out).toMatch(/context 8\.7k \/ 256k \(3%\)/);
		expect(out).toMatch(/\n[^\n]*context 8\.7k/); // a newline precedes the usage line
	});

	it("prompt parity: ❯ under UTF-8, > fallback otherwise", () => {
		const u = setup({ utf8: true });
		u.r.handle({ type: "idle" });
		expect(u.out()).toContain("❯");
		expect(u.out()).toContain("[95m"); // bright magenta, matching hax's purple prompt

		const a = setup({ utf8: false });
		a.r.handle({ type: "idle" });
		expect(a.out()).toContain("> ");
		expect(a.out()).not.toContain("❯");
	});

	it("error renders red AND returns to a prompt", () => {
		const t = setup({ utf8: true });
		t.r.handle({ type: "error", message: "boom" });
		const out = t.out();
		expect(out).toContain("[31m"); // red
		expect(out).toContain("boom");
		expect(out).toContain("❯"); // trailing prompt — pane usable again
	});

	it("echoUserInput paints a bright-magenta ▌ stripe + body, one trailing newline", () => {
		const t = setup({ utf8: true });
		t.r.echoUserInput("hello world", 80);
		const out = t.out();
		expect(out).toContain("[95m"); // bright magenta (hax stripe)
		expect(out).toContain("▌ hello world");
		expect(out.endsWith("\n")).toBe(true);
		expect((out.match(/▌ /g) || []).length).toBe(1); // single visual row
	});

	it("echoUserInput re-stripes every wrapped visual row (hax-exact wrap)", () => {
		const t = setup({ utf8: true });
		// cols=7 → body width = 7-2 = 5; 12 chars → rows of 5/5/2 = 3 stripes.
		t.r.echoUserInput("abcdefghijkl", 7);
		const out = t.out();
		expect((out.match(/▌ /g) || []).length).toBe(3);
		expect(out).toContain("▌ abcde");
		expect(out).toContain("▌ fghij");
		expect(out).toContain("▌ kl");
	});

	it("echoUserInput uses an ASCII | stripe when utf8 is off", () => {
		const t = setup({ utf8: false });
		t.r.echoUserInput("hi", 80);
		const out = t.out();
		expect(out).toContain("| hi");
		expect(out).not.toContain("▌");
	});
});
