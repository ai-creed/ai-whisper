import { describe, expect, it } from "vitest";
import { buildClaudePtySpawnOptions } from "../packages/adapter-claude/src/create-claude-live-session.ts";
import { buildCodexPtySpawnOptions } from "../packages/adapter-codex/src/create-codex-live-session.ts";

describe("provider PTY spawn options stamp AI_WHISPER_AGENT", () => {
	it("claude spawn options carry env.AI_WHISPER_AGENT=claude, geometry, and inherited AI_WHISPER_* vars", () => {
		const opts = buildClaudePtySpawnOptions({
			cols: 100,
			rows: 40,
			cwd: "/w",
			baseEnv: { AI_WHISPER_BROKER_PORT: "4500", PATH: "/x" },
		});
		expect(opts.cols).toBe(100);
		expect(opts.rows).toBe(40);
		expect(opts.cwd).toBe("/w");
		expect(opts.name).toBe("xterm-256color");
		expect(opts.env.AI_WHISPER_AGENT).toBe("claude");
		expect(opts.env.AI_WHISPER_BROKER_PORT).toBe("4500"); // inherited var preserved
		expect(opts.env.PATH).toBe("/x");
	});

	it("codex spawn options carry env.AI_WHISPER_AGENT=codex", () => {
		const opts = buildCodexPtySpawnOptions({
			cols: 80,
			rows: 24,
			cwd: "/w",
			baseEnv: { AI_WHISPER_COLLAB_ID: "c1" },
		});
		expect(opts.env.AI_WHISPER_AGENT).toBe("codex");
		expect(opts.env.AI_WHISPER_COLLAB_ID).toBe("c1");
	});

	it("claude spawn options pass duo persona env vars through unchanged", () => {
		const opts = buildClaudePtySpawnOptions({
			cols: 100,
			rows: 40,
			cwd: "/w",
			baseEnv: {
				AI_WHISPER_CHARACTER: "Batman",
				AI_WHISPER_CHARACTER_ROLE: "reviewer",
			},
		});
		expect(opts.env.AI_WHISPER_CHARACTER).toBe("Batman");
		expect(opts.env.AI_WHISPER_CHARACTER_ROLE).toBe("reviewer");
	});

	it("codex spawn options pass duo persona env vars through unchanged", () => {
		const opts = buildCodexPtySpawnOptions({
			cols: 80,
			rows: 24,
			cwd: "/w",
			baseEnv: {
				AI_WHISPER_CHARACTER: "Heisenberg",
				AI_WHISPER_CHARACTER_ROLE: "implementer",
			},
		});
		expect(opts.env.AI_WHISPER_CHARACTER).toBe("Heisenberg");
		expect(opts.env.AI_WHISPER_CHARACTER_ROLE).toBe("implementer");
	});
});
