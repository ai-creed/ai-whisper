import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function resolveCurrentTty(): string {
	// Windows has no /dev/tty device and no `tty` command; more fundamentally the
	// mounted relay drives an interactive Unix PTY session that Windows consoles
	// don't provide. Fail fast with an actionable message rather than a cryptic
	// `spawnSync tty ENOENT` from the execFileSync below. WSL2 is a real Linux
	// environment where the whole package runs as-is.
	if (process.platform === "win32") {
		throw new Error(
			"This command is not supported natively on Windows: it requires a Unix tty-backed shell to drive an interactive PTY session. " +
				"Run ai-whisper inside WSL2 (Windows Subsystem for Linux) instead — install Node, your agent CLI, and ai-whisper inside your WSL2 distro and run the command there. " +
				"Setup guide: https://learn.microsoft.com/windows/wsl/install",
		);
	}
	const stdin = process.stdin as NodeJS.ReadStream & { path?: string };
	const ttyPath =
		stdin.isTTY && typeof stdin.path === "string"
			? stdin.path
			: execFileSync("tty", [], {
					encoding: "utf8",
					stdio: ["inherit", "pipe", "pipe"],
				}).trim();
	if (!ttyPath.startsWith("/dev/")) {
		throw new Error(
			"Current shell is not attached to a local tty. This command requires a real tty-backed shell.",
		);
	}
	if (!existsSync(ttyPath)) {
		throw new Error(`Resolved tty does not exist: ${ttyPath}`);
	}
	return ttyPath;
}
