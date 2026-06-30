import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentType } from "@ai-whisper/shared";

// Agents that have a preset invocation. "ezio" is excluded because it is an
// SDK-based adapter, not a CLI, so it does not belong in the CLI-preset registry.
export type AgentCliAgent = Exclude<AgentType, "ezio">;

export type ChildProcessLike = {
	stdout: { on(e: "data", cb: (chunk: unknown) => void): void };
	stderr: { on(e: "data", cb: (chunk: unknown) => void): void };
	stdin: { write(data: string): void; end(): void };
	on(e: "error", cb: (err: Error) => void): void;
	on(e: "close", cb: (code: number | null) => void): void;
};

export type SpawnLike = (
	command: string,
	args: readonly string[],
	options: { stdio: [string, string, string] },
) => ChildProcessLike;

export const defaultSpawn: SpawnLike = (command, args, options) =>
	nodeSpawn(command, [...args], options as SpawnOptions) as unknown as ChildProcessLike;

export type AgentCliInvocation = { executable: string; execArgs: string[]; promptVia: "arg" | "stdin" };

// Validated presets (AC-7 probe — 2026-06-30). claude/codex/agy all use -p for
// non-interactive single-prompt output. agy was seeded conservatively as stdin but
// `agy --help` (agy v1.0.13) reveals `--print` / `-p` ("Run a single prompt
// non-interactively and print the response"), so the preset now mirrors claude.
const PRESETS: Record<AgentCliAgent, AgentCliInvocation> = {
	claude: { executable: "claude", execArgs: ["-p"], promptVia: "arg" },
	codex: { executable: "codex", execArgs: ["exec"], promptVia: "arg" },
	agy: { executable: "agy", execArgs: ["-p"], promptVia: "arg" },
};

export function resolveAgentCliInvocation(input: {
	agent: AgentCliAgent;
	executable?: string | null;
	execArgs?: string[] | null;
	promptVia?: "arg" | "stdin" | null;
}): AgentCliInvocation {
	const preset = PRESETS[input.agent];
	return {
		executable: input.executable ?? preset.executable,
		execArgs: input.execArgs ?? preset.execArgs,
		promptVia: input.promptVia ?? preset.promptVia,
	};
}

// Pure-filesystem PATH existence check (no spawn) — consistent with the daemon-free
// `whisper env` report. An executable containing a path separator is stat'd directly;
// a bare name is searched across $PATH entries.
export function isExecutableOnPath(executable: string): boolean {
	const isExecFile = (p: string): boolean => {
		try {
			if (!statSync(p).isFile()) return false;
			accessSync(p, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (executable.includes("/") || executable.includes("\\")) return isExecFile(executable);
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	return dirs.some((dir) => exts.some((ext) => isExecFile(join(dir, executable + ext))));
}
