import { execSync, spawn as nodeSpawn } from "node:child_process";
import type { AgentType } from "@ai-whisper/shared";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LaunchMode = "tmux" | "terminals" | "none";

export type SpawnFn = (command: string) => number | void;
export type ExecFn = (command: string) => void;

const __dirname = dirname(fileURLToPath(import.meta.url));
const whisperBinPath = resolve(__dirname, "../bin/whisper.js");
const relayMonitorBinPath = resolve(__dirname, "../bin/relay-monitor.js");

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export type LaunchResult = {
	launched: true;
	launchMode: LaunchMode;
	tmuxSession?: string;
	commands: {
		codex: string;
		claude: string;
		relayMonitor: string;
	};
	runtime: {
		codexPid?: number;
		claudePid?: number;
		relayMonitorPid?: number;
		codexWindowLabel?: string;
		claudeWindowLabel?: string;
		relayMonitorWindowLabel?: string;
	};
};

export function detectTmux(): boolean {
	try {
		execSync("which tmux", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function chooseLaunchMode(input: {
	tmuxAvailable: boolean;
	forceNoTmux: boolean;
	forceNoLaunch: boolean;
}): LaunchMode {
	if (input.forceNoLaunch) return "none";
	if (input.tmuxAvailable && !input.forceNoTmux) return "tmux";
	return "terminals";
}

function buildBrokerEnvPrefix(input: {
	brokerSqlitePath: string;
	brokerHost: string;
	brokerPort: number;
	collabId: string;
}): string {
	const explicitEnv = {
		AI_WHISPER_BROKER_SQLITE: input.brokerSqlitePath,
		AI_WHISPER_BROKER_HOST: input.brokerHost,
		AI_WHISPER_BROKER_PORT: String(input.brokerPort),
		AI_WHISPER_COLLAB_ID: input.collabId,
	} as const;

	const passthrough = Object.entries(process.env)
		.filter(
			(entry): entry is [string, string] =>
				entry[0].startsWith("AI_WHISPER_") &&
				!(entry[0] in explicitEnv) &&
				typeof entry[1] === "string" &&
				entry[1].length > 0,
		)
		.map(([key, value]) => `${key}=${shellQuote(value)}`);

	return [
		...Object.entries(explicitEnv).map(
			([key, value]) => `${key}=${shellQuote(value)}`,
		),
		...passthrough,
	].join(" ");
}

function buildMountCommand(
	agent: AgentType,
	envPrefix: string,
	workspaceRoot: string,
): string {
	return `${envPrefix} ${shellQuote(process.execPath)} ${shellQuote(whisperBinPath)} collab mount ${agent} --workspace ${shellQuote(workspaceRoot)}`;
}

function buildRelayMonitorCommand(
	envPrefix: string,
	workspaceRoot: string,
): string {
	return `AI_WHISPER_WORKSPACE_ROOT=${shellQuote(workspaceRoot)} ${envPrefix} ${shellQuote(process.execPath)} ${shellQuote(relayMonitorBinPath)}`;
}

function defaultSpawn(command: string): number | undefined {
	const child = nodeSpawn("sh", ["-c", command], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return child.pid;
}

function defaultExec(command: string): void {
	execSync(command, { stdio: "inherit" });
}

function wrapForTerminalWindow(agentCommand: string, label: string): string {
	if (process.platform === "darwin") {
		const escaped = agentCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const escapedLabel = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `osascript -e "tell application \\"Terminal\\" to do script \\"${escaped}\\"" -e "tell application \\"Terminal\\" to set custom title of front window to \\"${escapedLabel}\\""`;
	}
	return `x-terminal-emulator -e sh -lc ${shellQuote(agentCommand)} 2>/dev/null || xterm -title ${shellQuote(label)} -e sh -lc ${shellQuote(agentCommand)}`;
}

export function launchSessions(input: {
	launchMode: LaunchMode;
	attachTmux?: boolean;
	collabId: string;
	workspaceRoot: string;
	brokerSqlitePath: string;
	brokerHost: string;
	brokerPort: number;
	spawn?: SpawnFn;
	exec?: ExecFn;
}): LaunchResult {
	if (input.launchMode === "none") {
		throw new Error("launchSessions must not be called with launchMode 'none'");
	}

	const run = input.spawn ?? defaultSpawn;
	const exec = input.exec ?? defaultExec;

	const envPrefix = buildBrokerEnvPrefix({
		brokerSqlitePath: input.brokerSqlitePath,
		brokerHost: input.brokerHost,
		brokerPort: input.brokerPort,
		collabId: input.collabId,
	});

	const codexCmd = `cd ${shellQuote(input.workspaceRoot)} && ${buildMountCommand("codex", envPrefix, input.workspaceRoot)}`;
	const claudeCmd = `cd ${shellQuote(input.workspaceRoot)} && ${buildMountCommand("claude", envPrefix, input.workspaceRoot)}`;
	const relayMonitorCmd = buildRelayMonitorCommand(envPrefix, input.workspaceRoot);

	const codexWindowLabel = `whisper-${input.collabId}-codex`;
	const claudeWindowLabel = `whisper-${input.collabId}-claude`;
	const relayMonitorWindowLabel = `whisper-${input.collabId}-relay-monitor`;

	const base: LaunchResult = {
		launched: true,
		launchMode: input.launchMode,
		commands: {
			codex: codexCmd,
			claude: claudeCmd,
			relayMonitor: relayMonitorCmd,
		},
		runtime: {},
	};

	if (input.launchMode === "tmux") {
		const tmuxSession = `whisper-${input.collabId}`;
		base.tmuxSession = tmuxSession;

		// Start relay-monitor first so it registers before mount panes poll for it.
		// Mount panes retry for ~10s, so strict ordering is defensive but still preferred.
		exec(
			`tmux new-session -d -s ${shellQuote(tmuxSession)} -n main sh -lc ${shellQuote(relayMonitorCmd)}`,
		);
		if (process.env.AI_WHISPER_DEBUG_PANES === "1") {
			exec(`tmux set-option -t ${shellQuote(tmuxSession)} remain-on-exit on`);
		}
		// Split vertically at the top, pushing relay-monitor to the bottom 30%.
		// New top pane runs mount codex.
		exec(
			`tmux split-window -t ${shellQuote(`${tmuxSession}:0`)} -vb -l 70% sh -lc ${shellQuote(codexCmd)}`,
		);
		// Split the codex pane horizontally to add mount claude on the right.
		exec(
			`tmux split-window -t ${shellQuote(`${tmuxSession}:0.0`)} -h sh -lc ${shellQuote(claudeCmd)}`,
		);
		exec(`tmux set-option -t ${shellQuote(tmuxSession)} mouse on`);
		if (input.attachTmux) {
			exec(`tmux attach -t ${shellQuote(tmuxSession)}`);
		}
	} else {
		base.runtime.codexWindowLabel = codexWindowLabel;
		base.runtime.claudeWindowLabel = claudeWindowLabel;
		base.runtime.relayMonitorWindowLabel = relayMonitorWindowLabel;
		// Start relay-monitor first; mount windows retry until monitor registers.
		const relayMonitorPid = run(
			wrapForTerminalWindow(relayMonitorCmd, relayMonitorWindowLabel),
		);
		const codexPid = run(wrapForTerminalWindow(codexCmd, codexWindowLabel));
		const claudePid = run(wrapForTerminalWindow(claudeCmd, claudeWindowLabel));
		if (typeof relayMonitorPid === "number") {
			base.runtime.relayMonitorPid = relayMonitorPid;
		}
		if (typeof codexPid === "number") {
			base.runtime.codexPid = codexPid;
		}
		if (typeof claudePid === "number") {
			base.runtime.claudePid = claudePid;
		}
	}

	return base;
}
