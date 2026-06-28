import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node-pty";
import {
	ensureNodePtySpawnHelperExecutable,
	type InteractiveSessionController,
} from "@ai-whisper/shared";
import type { CursorCommandConfig } from "./cursor-command.js";

const require = createRequire(import.meta.url);
const nodePtyUnixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

type PtyLike = {
	onData(handler: (data: string) => void): unknown;
	onExit(handler: (e: { exitCode: number }) => void): unknown;
	write(data: string): void;
	resize(columns: number, rows: number): void;
	kill(): void;
};

type ResizableStdout = NodeJS.WritableStream & {
	columns?: number;
	rows?: number;
	on?(event: string, listener: () => void): unknown;
	off?(event: string, listener: () => void): unknown;
	removeListener?(event: string, listener: () => void): unknown;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// cursor (agent) is a full-screen TUI: it must be spawned at — and kept in sync
// with — the real terminal size, or it lays out for the wrong geometry (input
// box stranded mid-screen, dim/garbled redraws).
function ttySize(stdout: NodeJS.WritableStream): { cols: number; rows: number } {
	const s = stdout as ResizableStdout;
	const cols = typeof s.columns === "number" && s.columns > 0 ? s.columns : DEFAULT_COLS;
	const rows = typeof s.rows === "number" && s.rows > 0 ? s.rows : DEFAULT_ROWS;
	return { cols, rows };
}

function createNodePty(input: {
	config: CursorCommandConfig;
	cwd: string;
	cols: number;
	rows: number;
}): PtyLike {
	ensureNodePtySpawnHelperExecutable({
		unixTerminalPath: nodePtyUnixTerminalPath,
	});
	return spawn(
		input.config.executable,
		input.config.execArgs,
		buildCursorPtySpawnOptions({ cols: input.cols, rows: input.rows, cwd: input.cwd }),
	);
}

/**
 * Build the node-pty spawn options for a mounted Cursor session. Stamps
 * `AI_WHISPER_AGENT=cursor` into the child env so any `whisper` command the
 * agent shells out to (e.g. `workflow start`) knows the triggering agent, while
 * preserving the inherited `AI_WHISPER_*` broker variables.
 */
export function buildCursorPtySpawnOptions(input: {
	cols: number;
	rows: number;
	cwd: string;
	baseEnv?: NodeJS.ProcessEnv;
}): { name: string; cols: number; rows: number; cwd: string; env: { [key: string]: string } } {
	const env: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(input.baseEnv ?? process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	env.AI_WHISPER_AGENT = "cursor";
	return { name: "xterm-256color", cols: input.cols, rows: input.rows, cwd: input.cwd, env };
}

export function createCursorLiveSession(input: {
	config: CursorCommandConfig;
	cwd: string;
	stdout: NodeJS.WritableStream;
	createPty?: (input: {
		config: CursorCommandConfig;
		cwd: string;
		cols: number;
		rows: number;
	}) => PtyLike;
}): InteractiveSessionController {
	let pty: PtyLike | null = null;
	let exitHandler: (() => void) | null = null;
	let outputHandler: ((data: string) => void) | null = null;
	let onStdoutResize: (() => void) | null = null;

	function handleData(data: string) {
		outputHandler?.(data);
		input.stdout.write(data);
	}

	return {
		start() {
			const { cols, rows } = ttySize(input.stdout);
			pty = (input.createPty ?? createNodePty)({
				config: input.config,
				cwd: input.cwd,
				cols,
				rows,
			});
			pty.onData(handleData);
			pty.onExit(() => {
				exitHandler?.();
			});
			const s = input.stdout as ResizableStdout;
			if (typeof s.on === "function") {
				onStdoutResize = () => {
					const next = ttySize(input.stdout);
					pty?.resize(next.cols, next.rows);
				};
				s.on("resize", onStdoutResize);
			}
			return Promise.resolve();
		},
		stop() {
			const s = input.stdout as ResizableStdout;
			if (onStdoutResize) {
				(s.off ?? s.removeListener)?.call(s, "resize", onStdoutResize);
				onStdoutResize = null;
			}
			if (pty) {
				pty.kill();
				pty = null;
			}
			return Promise.resolve();
		},
		writeUserInput(data: string) {
			pty?.write(data);
		},
		resize(cols: number, rows: number) {
			pty?.resize(cols, rows);
		},
		sendLocalMessage(message: string) {
			// Instrumentation only (env-gated, no behaviour change): capture the
			// exact chrome bytes ai-whisper splices into the shared cursor stdout
			// so any TUI-corruption (dim / misplaced input) can be root-caused.
			const localLog = process.env.AI_WHISPER_DEBUG_LOCAL_LOG;
			if (localLog) {
				try {
					appendFileSync(
						localLog,
						`${new Date().toISOString()} cursor ${JSON.stringify(message)}\n`,
					);
				} catch {
					// best-effort; never disturb the session
				}
			}
			input.stdout.write(message);
		},
		onExit(handler: () => void) {
			exitHandler = handler;
		},
		onProviderOutput(handler: (data: string) => void) {
			outputHandler = handler;
		},
	};
}
