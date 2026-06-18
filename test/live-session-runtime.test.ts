import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFakePty } from "./helpers/fake-pty.ts";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";

let _mockStdin: PassThrough | null = null;

function createMockStdin() {
	_mockStdin = new PassThrough();
	return _mockStdin;
}

function emitInput(data: string) {
	_mockStdin!.write(data);
}

function nextTick() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("live session runtime", () => {
	it("forwards ordinary byte input to the host session without waiting for newline", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("a");
		stdin.write("\u0003");

		expect(fakePty.writes.join("")).toContain("a");
		expect(fakePty.writes.join("")).toContain("\u0003");
	});

	it("lineBufferedInput: accumulates keystrokes, echoes them, and submits the whole line on Enter", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const echoed: string[] = [];
		stdout.on("data", (c) => echoed.push(String(c)));
		const submits: string[] = [];

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					submits.push(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});

		await runtime.start();
		for (const ch of "hi") stdin.write(ch);
		await nextTick();
		// Nothing submitted before Enter; keystrokes are echoed locally.
		expect(submits).toEqual([]);
		expect(echoed.join("")).toContain("h");
		expect(echoed.join("")).toContain("i");

		stdin.write("\r");
		await nextTick();
		// Exactly one submit with the full line (no trailing CR), not one per char.
		expect(submits).toEqual(["hi"]);
	});

	it("lineBufferedInput + real ai-ezio controller: re-paints the submitted line as a magenta ▌ stripe", async () => {
		// End-to-end proof of the hax-style submitted-prompt echo: the REAL
		// createAiEzioLiveSession controller is driven through the runtime with a
		// fake engine. On Enter the runtime erases its plain echo and calls the
		// controller's echoUserInput, which paints the bright-magenta stripe.
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const out: string[] = [];
		stdout.on("data", (c) => out.push(String(c)));

		const controller = createAiEzioLiveSession({
			stdout,
			createEngineSession: () => ({
				start: () => Promise.resolve({ type: "ready" }),
				transcriptPath: undefined,
				newConversation: async () => {},
				status: async () => ({ provider: "mock", model: "mock" }),
				submit: () => {},
				interrupt: () => {},
				submitAndWait: () => Promise.resolve({ turnId: "t", content: "" }),
				registerDelegatedTools: () => {},
				sendToolResult: () => {},
				onExit: () => {},
				close: () => {},
			}),
		});

		const runtime = createLiveSessionRuntime({
			interactiveSession: controller,
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});

		await runtime.start();
		for (const ch of "hi") stdin.write(ch);
		stdin.write("\r");
		await nextTick();

		const s = out.join("");
		expect(s).toContain("[95m"); // bright-magenta stripe (hax purple)
		expect(s).toContain("▌ hi"); // submitted line re-painted with the stripe
		expect(s).toContain("[J"); // erase-to-end-of-screen before the re-paint
	});

	function ctrlKeyFixture() {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const out: string[] = [];
		stdout.on("data", (c) => out.push(String(c)));
		const calls = { interrupt: 0, stop: 0, submits: [] as string[] };
		const interactiveSession = {
			start: () => Promise.resolve(),
			stop: () => {
				calls.stop++;
				return Promise.resolve();
			},
			interrupt: () => {
				calls.interrupt++;
			},
			writeUserInput(data: string) {
				calls.submits.push(data);
			},
			sendLocalMessage(message: string) {
				stdout.write(message);
			},
			onExit() {},
			onTurnFinished() {}, // marks this as a protocol-native (line-buffered) session
		};
		const runtime = createLiveSessionRuntime({
			interactiveSession,
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});
		return { stdin, out: () => out.join(""), calls, runtime };
	}

	it("Ctrl+C mid-turn (empty buffer) interrupts the running turn", async () => {
		const f = ctrlKeyFixture();
		await f.runtime.start();
		f.stdin.write("\u0003"); // Ctrl+C with nothing typed
		await nextTick();
		expect(f.calls.interrupt).toBe(1);
		expect(f.calls.submits).toEqual([]);
		expect(f.calls.stop).toBe(0);
	});

	it("Ctrl+C with typed text clears the line and does NOT interrupt or submit", async () => {
		const f = ctrlKeyFixture();
		await f.runtime.start();
		for (const ch of "abc") f.stdin.write(ch);
		f.stdin.write("\u0003"); // Ctrl+C clears the typed input
		await nextTick();
		expect(f.calls.interrupt).toBe(0);
		expect(f.calls.submits).toEqual([]);
		// A subsequent Enter submits nothing — the buffer was cleared.
		f.stdin.write("\r");
		await nextTick();
		expect(f.calls.submits).toEqual([]);
		expect(f.out()).toContain("\b \b"); // visually erased the typed chars
	});

	it("Ctrl+D exits immediately by stopping the session", async () => {
		const f = ctrlKeyFixture();
		await f.runtime.start();
		f.stdin.write("\u0004"); // Ctrl+D
		await nextTick();
		expect(f.calls.stop).toBe(1);
	});

	it("lineBufferedInput: backspace edits the buffer before submit", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const submits: string[] = [];

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					submits.push(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});

		await runtime.start();
		for (const ch of "hx") stdin.write(ch);
		stdin.write(""); // backspace removes the "x"
		stdin.write("i");
		stdin.write("\r");
		await nextTick();
		expect(submits).toEqual(["hi"]);
	});

	it("lineBufferedInput: a bare Enter does not submit an empty turn", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const submits: string[] = [];

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					submits.push(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});

		await runtime.start();
		stdin.write("\r");
		await nextTick();
		expect(submits).toEqual([]);
	});

	function localCommandFixture(
		tryConsumeLocalCommand: (line: string) => Promise<boolean>,
	) {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const out: string[] = [];
		stdout.on("data", (c) => out.push(String(c)));
		const calls = {
			submits: [] as string[],
			echoes: [] as string[],
			consumed: [] as string[],
		};
		const interactiveSession = {
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			writeUserInput(data: string) {
				calls.submits.push(data);
			},
			echoUserInput(text: string) {
				calls.echoes.push(text);
				stdout.write("__STRIPE__");
			},
			sendLocalMessage(message: string) {
				stdout.write(message);
			},
			onExit() {},
			onTurnFinished() {}, // marks this as a protocol-native (line-buffered) session
			tryConsumeLocalCommand(line: string) {
				calls.consumed.push(line);
				return tryConsumeLocalCommand(line);
			},
		};
		const runtime = createLiveSessionRuntime({
			interactiveSession,
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});
		return { stdin, out: () => out.join(""), calls, runtime };
	}

	it("lineBufferedInput: a consumed operator slash command renders locally without submitting or repainting a stripe", async () => {
		const f = localCommandFixture(async (_line) => true);

		await f.runtime.start();
		f.stdin.write("/help\r");
		await nextTick();

		// A consumed command is never submitted and never re-painted as a stripe.
		expect(f.calls.consumed).toEqual(["/help"]);
		expect(f.calls.submits).toEqual([]);
		expect(f.calls.echoes).toEqual([]);
	});

	it("lineBufferedInput: erases the echoed operator input BEFORE the consumed command renders its output", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const out: string[] = [];
		stdout.on("data", (c) => out.push(String(c)));
		const submits: string[] = [];
		const echoes: string[] = [];

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					submits.push(data);
				},
				echoUserInput(text: string) {
					echoes.push(text);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
				onTurnFinished() {},
				tryConsumeLocalCommand(_line: string) {
					stdout.write("__CMD__");
					return Promise.resolve(true);
				},
			},
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
			lineBufferedInput: true,
		});

		await runtime.start();
		stdin.write("/help\r");
		await nextTick();

		const s = out.join("");
		const eraseIdx = s.indexOf("[J");
		const cmdIdx = s.indexOf("__CMD__");
		expect(eraseIdx).toBeGreaterThanOrEqual(0);
		expect(cmdIdx).toBeGreaterThanOrEqual(0);
		// The echoed input is cleared to end-of-screen before the command output.
		expect(eraseIdx).toBeLessThan(cmdIdx);
		// No magenta stripe and no turn submission for a consumed command.
		expect(submits).toEqual([]);
		expect(echoes).toEqual([]);
	});

	it("lineBufferedInput: an ordinary (non-command) line still submits and repaints the magenta stripe", async () => {
		const f = localCommandFixture(async (_line) => false);

		await f.runtime.start();
		f.stdin.write("hello\r");
		await nextTick();

		expect(f.calls.consumed).toEqual(["hello"]);
		expect(f.calls.submits).toEqual(["hello"]);
		expect(f.calls.echoes).toEqual(["hello"]);
	});

	it("consumes relay directives and writes local acknowledgement instead of forwarding them", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to codex on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@@codex review this plan\n");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes.join("")).not.toContain(
			"@@codex review this plan",
		);
		expect(output.join("")).toContain("Relayed to codex");
	});

	it("renders a local colored relay preview while composing a relay directive", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to claude on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@@claude");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes).toEqual([]);
		expect(output.join("")).toContain("@@claude");
		expect(output.join("")).toContain("\u001b[38;5;215m");
	});

	it("clears the local relay preview before printing the relay acknowledgement", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to claude on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@@claude test\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes).toEqual([]);
		expect(output.join("")).toContain("\u001b[2K");
		expect(output.join("")).toContain("Relayed to claude");
	});

	it("rejects unsupported advanced relay syntax locally", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("@@codex[thread:thread_123] continue\n");

		expect(fakePty.writes.join("")).not.toContain("thread_123");
		expect(output.join("")).toContain("Unsupported relay syntax");
	});

	it("drops terminal response escape sequences instead of forwarding them to the host session", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("\u001b[1;1R");
		stdin.write("\u001b[>71;2;4c");
		stdin.write("\u001b]10;rgb:dcdc/dcdc/dcdc\u001b\\");

		expect(fakePty.writes).toEqual([]);
	});

	it("ignores mouse and focus escape sequences when they share a chunk with a relay directive", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to codex on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("\u001b[I\u001b[<0;40;12M@@codex review this plan\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes.join("")).not.toContain(
			"@@codex review this plan",
		);
		expect(output.join("")).toContain("Relayed to codex");
	});

	it("enables raw stdin mode while the live session is active", async () => {
		const stdout = new PassThrough();
		const rawModeCalls: boolean[] = [];
		const stdin = new PassThrough() as PassThrough & {
			isTTY: boolean;
			isRaw: boolean;
			setRawMode(mode: boolean): void;
		};
		stdin.isTTY = true;
		stdin.isRaw = false;
		stdin.setRawMode = (mode: boolean) => {
			rawModeCalls.push(mode);
			stdin.isRaw = mode;
		};

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput() {},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
					onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		await runtime.stop();

		expect(rawModeCalls).toEqual([true, false]);
	});

	it("pauses stdin handling and raw mode while modal input is active", async () => {
		const stdout = new PassThrough();
		const rawModeCalls: boolean[] = [];
		const stdin = new PassThrough() as PassThrough & {
			isTTY: boolean;
			isRaw: boolean;
			setRawMode(mode: boolean): void;
		};
		stdin.isTTY = true;
		stdin.isRaw = false;
		stdin.setRawMode = (mode: boolean) => {
			rawModeCalls.push(mode);
			stdin.isRaw = mode;
		};

		const userInputs: string[] = [];
		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					userInputs.push(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () => Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		await runtime.withPausedInput(async () => {
			stdin.write("/\u001b[47;1:3u");
			await nextTick();
		});
		stdin.write("a");
		await nextTick();
		await runtime.stop();

		expect(userInputs).toEqual(["a"]);
		expect(rawModeCalls).toEqual([true, false, true, false]);
	});

	it("drops printable CSI-u keyboard echoes before relay parsing", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to claude on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@\u001b[50:64;2:3u@\u001b[50:64;2:3uclaude say hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes).toEqual([]);
		expect(output.join("")).toContain("Relayed to claude");
		expect(output.join("")).not.toContain("[50:64;2:3u");
	});

	it("drops printable CSI-u keyboard echoes before passthrough to the provider", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("a\u001b[97;1:3ub\u001b[98;1:3uc\u001b[99;1:3u");

		expect(fakePty.writes.join("")).toBe("abc");
	});

	it("decodes printable CSI-u-only input before passthrough to the provider", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("\u001b[97;1:3u\u001b[98;1:3u\u001b[99;1:3u");

		expect(fakePty.writes.join("")).toBe("abc");
	});

	it("deduplicates printable input when iTerm sends both literal bytes and matching CSI-u sequences", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to claude on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@\u001b[50:64;2:3u@\u001b[50:64;2:3uc\u001b[99;1ul\u001b[108;1ua\u001b[97;1uu\u001b[117;1ud\u001b[100;1ue\u001b[101;1u say hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes).toEqual([]);
		expect(output.join("")).toContain("Relayed to claude");
		expect(output.join("")).not.toContain("@@@@");
		expect(output.join("")).not.toContain("@@ccllaauuddee");
	});

	it("deduplicates printable input when literal bytes and CSI-u reports arrive in separate chunks", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to claude on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@");
		stdin.write("\u001b[50:64;2:3u");
		stdin.write("@");
		stdin.write("\u001b[50:64;2:3u");
		stdin.write("claude say hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes).toEqual([]);
		expect(output.join("")).toContain("Relayed to claude");
		expect(output.join("")).not.toContain("@@@@");
	});

	it("deduplicates recent literal runs when fast typing arrives as literal bytes followed by a CSI-u batch", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("te");
		stdin.write("\u001b[116;1u\u001b[101;1u");

		expect(fakePty.writes.join("")).toBe("te");
	});

	it("deduplicates out-of-order CSI-u echoes that arrive after later literal bytes", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("t");
		stdin.write("\u001b[116;1:3u");
		stdin.write("e");
		stdin.write("l");
		stdin.write("\u001b[101;1:3u");
		stdin.write("\u001b[108;1:3u");
		stdin.write("l");
		stdin.write("\u001b[108;1:3u");

		expect(fakePty.writes.join("")).toBe("tell");
	});

	it("does not corrupt an inline relay preview when Codex replays out-of-order CSI-u echoes", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("@");
		stdin.write("\u001b[50:64;2:3u");
		stdin.write("@");
		stdin.write("\u001b[50:64;2:3u");
		stdin.write("t");
		stdin.write("\u001b[116;1:3u");
		stdin.write("e");
		stdin.write("l");
		stdin.write("\u001b[101;1:3u");
		stdin.write("\u001b[108;1:3u");
		stdin.write("l");
		stdin.write("\u001b[108;1:3u");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes).toEqual([]);
		expect(output.join("")).toContain("@@tell");
		expect(output.join("")).not.toContain("@@telell");
	});

	it("decodes Ctrl+C CSI-u reports to interrupt bytes instead of forwarding literal escape text", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("\u001b[99;5u\u001b[99;5:3u");

		expect(fakePty.writes.join("")).toBe("\u0003");
	});

	it("forwards each Ctrl+C press exactly once even when iTerm also emits CSI-u release reports", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("\u001b[99;5u\u001b[99;5:3u");
		stdin.write("\u001b[99;5u\u001b[99;5:3u");

		expect(fakePty.writes.join("")).toBe("\u0003\u0003");
	});

	it("drops standalone focus in/out escape sequences instead of forwarding them to the provider", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("\u001b[O\u001b[I");

		expect(fakePty.writes).toEqual([]);
	});

	it("drops terminal keyboard-mode status reports instead of forwarding them to the provider", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				onExit() {},
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("\u001b[?7u");

		expect(fakePty.writes).toEqual([]);
	});

	it("handles @@pull by injecting relay context into PTY via writeUserInput", async () => {
		const userInputs: string[] = [];
		const localMessages: string[] = [];
		const interactiveSession = {
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			writeUserInput(data: string) { userInputs.push(data); },
			sendLocalMessage(message: string) { localMessages.push(message); },
			onExit() {},
		};

		const runtime = createLiveSessionRuntime({
			interactiveSession,
			stdin: createMockStdin(),
			stdout: process.stdout,
			onRelay: (directive, sendNow) => {
				if (directive.target === "pull") {
					interactiveSession.writeUserInput(
						"[Context from recent relay exchange]\ncodex reviewed:\n\"Found issues\"\n\n",
					);
					sendNow("\u001b[2m↳ relay context attached (codex review: 3 findings)\u001b[0m\n");
					return Promise.resolve(null);
				}
				return Promise.resolve(null);
			},
		});

		await runtime.start();
		emitInput("@@pull\r");
		await nextTick();

		expect(userInputs.some((m) => m.includes("[Context from recent relay exchange]"))).toBe(true);
		expect(localMessages.some((m) => m.includes("relay context attached"))).toBe(true);
	});

	it("runInteractiveOverlay: suspends normal line input during the overlay and restores it afterward", async () => {
		const s = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void };
		s.isTTY = true;
		s.isRaw = false;
		const rawModes: boolean[] = [];
		s.setRawMode = (m: boolean) => void (rawModes.push(m), (s.isRaw = m));

		const out: string[] = [];
		const submitted: string[] = [];
		const session = {
			start: async () => {},
			stop: async () => {},
			writeUserInput: (d: string) => void submitted.push(d),
			tryConsumeLocalCommand: async () => false, // plain line → falls through to submit
			sendLocalMessage: () => {},
			onExit: () => {},
		} as never;
		const runtime = createLiveSessionRuntime({
			interactiveSession: session,
			stdin: s,
			stdout: { write: (d: string) => void out.push(d) } as never,
			onRelay: async () => null,
			lineBufferedInput: true,
		});
		await runtime.start();

		// Baseline: a normal line submits via the line reader BEFORE any overlay.
		s.write("a\r");
		await nextTick();
		expect(submitted).toEqual(["a"]);

		// While the overlay is active, raw chunks reach the picker — NOT the line buffer.
		const got: string[] = [];
		const overlay = runtime.runInteractiveOverlay(async (io) => {
			io.write("OVERLAY");
			for await (const k of io.keys) {
				got.push(k);
				if (k === "\r") break;
			}
		});
		await nextTick(); // let the overlay install its stdin routing
		s.write("\x1b[B"); // arrow down (one chunk)
		await nextTick();
		s.write("\r"); // enter → overlay breaks (separate chunk)
		await nextTick();
		await overlay;
		expect(got).toEqual(["\x1b[B", "\r"]); // overlay got the raw keys
		expect(out.join("")).toContain("OVERLAY");
		expect(submitted).toEqual(["a"]); // SUSPENDED: nothing submitted while the overlay owned input

		// After the overlay: the line reader is RESTORED — a normal line submits again.
		s.write("b\r");
		await nextTick();
		expect(submitted).toEqual(["a", "b"]); // RESTORED: pausedInputDepth decremented + routing back to the line buffer
		expect(s.isRaw).toBe(true); // mounted default raw mode preserved
	});

	it("blocks input while relay work is in progress", async () => {
		const localMessages: string[] = [];
		const userInputs: string[] = [];
		let relayWorkResolve: () => void;
		const relayWorkPromise = new Promise<void>((r) => { relayWorkResolve = r; });

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) { userInputs.push(data); },
				sendLocalMessage(message: string) { localMessages.push(message); },
				onExit() {},
			},
			stdin: createMockStdin(),
			stdout: process.stdout,
			onRelay: async () => {
				await relayWorkPromise;
				return null;
			},
			onRelayCancel: () => {}, // no-op — this test is about input blocking, not cancellation
		});

		await runtime.start();

		// Trigger relay
		emitInput("@@codex review\r");

		// Try to type while relay is in progress — should be blocked
		emitInput("hello");
		expect(userInputs.join("")).not.toContain("hello");

		// Complete relay work
		relayWorkResolve!();
		await nextTick();

		// Now input should work
		emitInput("hello again");
		expect(userInputs.join("")).toContain("hello again");
	});
});
