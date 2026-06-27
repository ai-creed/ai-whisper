// test/adapter-antigravity-live-session.test.ts
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

describe("antigravity live session", () => {
	it("stamps AI_WHISPER_AGENT=agy and copies only string env entries", async () => {
		const { buildAntigravityPtySpawnOptions } = await import(
			"../packages/adapter-antigravity/src/create-antigravity-live-session.ts",
		);
		const opts = buildAntigravityPtySpawnOptions({
			cols: 80,
			rows: 24,
			cwd: "/tmp/x",
			baseEnv: { KEEP: "yes", DROP: undefined as unknown as string },
		});
		expect(opts.env.AI_WHISPER_AGENT).toBe("agy");
		expect(opts.env.KEEP).toBe("yes");
		expect("DROP" in opts.env).toBe(false);
		expect(opts).toMatchObject({ name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp/x" });
	});

	it("relays provider output to stdout and the output handler", async () => {
		const { createAntigravityLiveSession } = await import(
			"../packages/adapter-antigravity/src/create-antigravity-live-session.ts",
		);
		const stdout = new PassThrough();
		let dataCb: ((d: string) => void) | undefined;
		const fakePty = {
			onData: (h: (d: string) => void) => { dataCb = h; },
			onExit: vi.fn(),
			write: vi.fn(),
			resize: vi.fn(),
			kill: vi.fn(),
		};
		const session = createAntigravityLiveSession({
			config: { executable: "agy", execArgs: [] },
			cwd: "/tmp/x",
			stdout,
			createPty: () => fakePty,
		});
		const captured: string[] = [];
		session.onProviderOutput?.((d) => captured.push(d));
		await session.start();
		(dataCb as ((d: string) => void) | undefined)?.("hello");
		expect(captured).toEqual(["hello"]);
		session.writeUserInput("hi");
		expect(fakePty.write).toHaveBeenCalledWith("hi");
	});

	it("builds a three-line interactive broker prompt referencing the request file", async () => {
		const { buildAntigravityInteractiveBrokerPrompt } = await import(
			"../packages/adapter-antigravity/src/antigravity-live-session-prompt.ts",
		);
		const prompt = buildAntigravityInteractiveBrokerPrompt("/tmp/req.json", "work_1");
		expect(prompt).toContain("/tmp/req.json");
		expect(prompt).toContain("work_1");
	});
});
