import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";
import { writeFileSync } from "node:fs";
import { createSessionTitleStore, type TitleFs } from "@ai-ezio/harness";

/** In-memory TitleFs for deterministic tests — copied from session-titles.test.ts. */
function memFs(seed: Record<string, string> = {}): TitleFs & { files: Map<string, string> } {
	const files = new Map<string, string>(Object.entries(seed));
	return {
		files,
		readFileSync: (p) => files.get(p),
		writeFileSync: (p, d) => void files.set(p, d),
		renameSync: (from, to) => {
			const v = files.get(from);
			if (v === undefined) throw new Error(`ENOENT ${from}`);
			files.set(to, v);
			files.delete(from);
		},
		mkdirSync: () => {},
	};
}

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
		resume: vi.fn(async () => {}),
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

/** A DelegatedToolProvider stub for the adapter's injected `mcpHost`. The adapter
 * wraps it in a DelegatedToolRegistry whose start() calls init()/tools(), so a
 * stub needs tools() — the pre-registry {start,handleEvent} shape no longer
 * satisfies the seam. No tools are advertised: these tests don't route calls. */
function fakeMcpHost() {
	return {
		id: "mcp",
		init: vi.fn(async () => {}),
		tools: () => [],
		handleToolCall: vi.fn(),
		stop: vi.fn(async () => {}),
	} as never;
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
		expect(out).toMatch(/8\.7k \/ 256k \(3%\)/); // usage line (renderer)
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
			resume: vi.fn(async () => {}),
			onExit: vi.fn(),
			close: vi.fn(),
		};
		const controller = createAiEzioLiveSession({
			createEngineSession: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
				onEvent = opts.onEvent;
				return session;
			},
			mcpHost: fakeMcpHost(),
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

	it("showTranscript dumps the minted transcript inline via the same render path as /transcript", async () => {
		const h = harness();
		await h.controller.start();
		writeFileSync(h.session.transcriptPath as string, "TRANSCRIPT_BODY");
		await h.controller.showTranscript?.();
		const keyDump = h.writes.join("");
		expect(keyDump).toContain("TRANSCRIPT_BODY");
		// Same render path as the slash command: the slash dump is identical output.
		h.writes.length = 0;
		expect(await h.controller.tryConsumeLocalCommand?.("/transcript")).toBe(true);
		expect(h.writes.join("")).toBe(keyDump);
	});

	it("showTranscript before start() reports no transcript yet", async () => {
		const h = harness();
		await h.controller.showTranscript?.();
		expect(h.writes.join("")).toBe("no transcript yet\n");
	});
});

// Stage 3: /rename + /resume wiring in the mounted adapter.
describe("createAiEzioLiveSession — /rename + /resume wiring", () => {
	/** Minimal fake engine for rename/resume tests. */
	function makeEngine(resumeSpy?: ReturnType<typeof vi.fn>) {
		let capturedOnEvent: (e: ProtocolEvent) => void = () => {};
		const resume = resumeSpy ?? vi.fn(async () => {});
		const session: AiEzioEngineSession = {
			start: vi.fn(async (opts?: { transcriptPath?: string }) => {
				session.transcriptPath = opts?.transcriptPath ?? "";
				return { type: "ready" };
			}),
			transcriptPath: undefined,
			newConversation: vi.fn(async () => {}),
			status: vi.fn(async () => ({ provider: "mock", model: "mock", sessionId: "active" })),
			submit: vi.fn(),
			interrupt: vi.fn(),
			submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
			registerDelegatedTools: vi.fn(),
			sendToolResult: vi.fn(),
			resume,
			onExit: vi.fn(),
			close: vi.fn(),
		};
		return {
			session,
			create: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
				capturedOnEvent = opts.onEvent;
				return session;
			},
			emit: (e: ProtocolEvent) => capturedOnEvent(e),
			resume,
		};
	}

	it("/rename writes the injected title store under the session id", async () => {
		const store = createSessionTitleStore({ filePath: "/t.json", fs: memFs() });
		const eng = makeEngine();
		const writes: string[] = [];
		const controller = createAiEzioLiveSession({
			createEngineSession: eng.create,
			mcpHost: fakeMcpHost(),
			buildAutoCompact: () => null,
			titleStore: store,
			stdout: { write: (s: string) => (writes.push(s), true) } as never,
		});
		await controller.start();
		// Feed a ready event so the rename controller captures the session id.
		eng.emit({ type: "ready", sessionId: "uuid-a", protocol: "1", haxBaseCommit: "c" });
		await controller.tryConsumeLocalCommand?.("/rename my title");
		expect(store.getTitle("uuid-a")).toBe("my title");
		expect(writes.join("")).toContain("my title");
	});

	it("/resume with a stub list + fake overlay selecting the only other row calls engine.resume with that id", async () => {
		const store = createSessionTitleStore({ filePath: "/t.json", fs: memFs() });
		const resumeSpy = vi.fn(async () => {});
		const eng = makeEngine(resumeSpy);
		const writes: string[] = [];
		const controller = createAiEzioLiveSession({
			createEngineSession: eng.create,
			mcpHost: fakeMcpHost(),
			buildAutoCompact: () => null,
			titleStore: store,
			now: () => 0,
			listSessions: async () =>
				JSON.stringify([
					{ id: "active", mtime: 2, firstPrompt: "a" },
					{ id: "other", mtime: 1, firstPrompt: "b" },
				]),
			runInteractiveOverlay: async (run) =>
				run({
					keys: (async function* () { yield "\r"; })(),
					write: (s) => { writes.push(s); },
					setRawMode: () => {},
				}),
			stdout: { write: (s: string) => (writes.push(s), true) } as never,
		});
		await controller.start();
		// Feed ready so the rename controller knows the active id (excluded from list).
		eng.emit({ type: "ready", sessionId: "active", protocol: "1", haxBaseCommit: "c" });
		await controller.tryConsumeLocalCommand?.("/resume");
		// "active" is excluded; "other" is the only row; Enter selects row 0.
		expect(resumeSpy).toHaveBeenCalledWith("other", expect.anything());
	});

	it("/resume right after a submit is refused (busy) — picker never opens, no respawn, no teardown", async () => {
		// Spec §4 busy guard, mounted race: a turn is in flight the moment writeUserInput
		// submits — BEFORE `assistant_turn_started` arrives. A /resume entered in that
		// window (e.g. a pasted "foo\n/resume\n") must be refused, not turned into a
		// fatal pane exit. Requires inTurn to be set AT submit.
		const store = createSessionTitleStore({ filePath: "/t.json", fs: memFs() });
		const resumeSpy = vi.fn(async () => {});
		const eng = makeEngine(resumeSpy);
		const writes: string[] = [];
		const overlaySpy = vi.fn(async () => {});
		const exits: number[] = [];
		const controller = createAiEzioLiveSession({
			createEngineSession: eng.create,
			mcpHost: fakeMcpHost(),
			buildAutoCompact: () => null,
			titleStore: store,
			now: () => 0,
			listSessions: async () => JSON.stringify([{ id: "other", mtime: 1, firstPrompt: "b" }]),
			runInteractiveOverlay: overlaySpy as never,
			stdout: { write: (s: string) => (writes.push(s), true) } as never,
		});
		controller.onExit(() => exits.push(1));
		await controller.start();
		eng.emit({ type: "ready", sessionId: "active", protocol: "1", haxBaseCommit: "c" });
		// Submit a turn, then IMMEDIATELY /resume — no assistant_turn_started in between.
		controller.writeUserInput("kick off a turn");
		await controller.tryConsumeLocalCommand?.("/resume");
		expect(writes.join("")).toContain("finish or interrupt the current turn first");
		expect(overlaySpy).not.toHaveBeenCalled(); // picker never opened
		expect(resumeSpy).not.toHaveBeenCalled(); // no respawn
		expect(exits).toEqual([]); // pane NOT torn down (no onFatal)
	});
});

// Stage 3: real-harness mounted e2e (/rename then /resume).
// Guard: the hax binary at the vendored dev path must exist.
const haxBuilt = existsSync(
	new URL("../../ai-ezio/vendor/hax/build/hax", import.meta.url),
);

describe.runIf(haxBuilt)(
	"mounted /rename then /resume (real harness, mock engine)",
	() => {
		it(
			"persists the title, switches the live session, and re-renders the banner",
			async () => {
				const saved = process.env.HAX_PROVIDER;
				process.env.HAX_PROVIDER = "mock";
				try {
					const { Session } = await import("@ai-ezio/harness");

					// 1. Pre-seed a PAST session in the cwd so /resume has something to switch to.
					const past = new Session();
					await past.start();
					await past.submitAndWait("PAST SESSION");
					const pastStatus = await past.status();
					const pastId = pastStatus.sessionId;
					past.close();

					// Helper: wait for a condition to become true.
					const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
						const t0 = Date.now();
						while (!pred()) {
							if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
							await new Promise<void>((r) => setTimeout(r, 20));
						}
					};

					// 2. Build the adapter with the real default createEngineSession (real Session),
					//    an in-memory title store, an injected list returning the past session,
					//    and an overlay that immediately presses Enter to select the first row.
					const store = createSessionTitleStore({ filePath: "/t.json", fs: memFs() });
					const out: string[] = [];
					const controller = createAiEzioLiveSession({
						// Real default engine (no createEngineSession override).
						mcpHost: fakeMcpHost(),
						buildAutoCompact: () => null,
						titleStore: store,
						listSessions: async () =>
							JSON.stringify([{ id: pastId, mtime: 1, firstPrompt: "PAST SESSION" }]),
						runInteractiveOverlay: async (run) =>
							run({
								keys: (async function* () { yield "\r"; })(),
								write: (s) => { out.push(s); },
								setRawMode: () => {},
							}),
						stdout: { write: (s: string) => (out.push(s), true) } as never,
					});

					try {
						await controller.start();
					} catch (e) {
						throw new Error(`controller.start() threw: ${(e as Error).message ?? String(e)}`);
					}

					// 3. Submit a turn to force the engine to materialize the session id.
					// The mock engine has sessionId="unknown" until the first turn; after
					// the turn completes and the rename controller receives the idle + a
					// subsequent status, it captures the real UUID.
					await new Promise<void>((resolve) => {
						controller.onTurnFinished?.(() => resolve());
						controller.writeUserInput("active turn");
					});

					// /rename my-title (spec order: rename BEFORE /resume so the pre-resume
					// title is persisted under the active id).
					await controller.tryConsumeLocalCommand?.("/rename my-title");
					// Wait for the store to reflect the title under any id (the status
					// refresh triggered by the idle is async; the rename controller
					// flushes the pending title on the next status event with the real UUID).
					await waitFor(() => [...store.loadTitles().values()].includes("my-title"), 8000);

					// 4. /resume → overlay selects the past session → real harness respawns.
					out.length = 0;
					await controller.tryConsumeLocalCommand?.("/resume");

					// Wait for the banner to re-render (the post-respawn ready flows through onEvent).
					await waitFor(() => out.join("").includes("ezio"), 8000);

					// 5a. Session SWITCHED: /rename under the new live id targets pastId.
					await controller.tryConsumeLocalCommand?.("/rename switched");
					await waitFor(() => store.getTitle(pastId) === "switched", 3000);
					expect(store.getTitle(pastId)).toBe("switched");

					// 5b. Banner RE-RENDERED: post-resume ready triggered renderer.
					expect(out.join("")).toMatch(/ezio/);

					await controller.stop();
				} finally {
					if (saved === undefined) delete process.env.HAX_PROVIDER;
					else process.env.HAX_PROVIDER = saved;
				}
			},
			30_000, // generous timeout for real hax spawns
		);
	},
);
