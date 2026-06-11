import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeClaudeSettingsFile(input: {
	stateRoot: string;
	workspaceId: string;
	shimPath: string;
	socketsDir: string;
	logsDir: string;
}): string {
	const dir = join(input.stateRoot, "providers", "claude");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${input.workspaceId}.json`);
	const command = `${input.shimPath} --provider claude --socket-dir ${input.socketsDir} --log-dir ${input.logsDir}`;
	const settings = {
		hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
	};
	writeFileSync(file, JSON.stringify(settings, null, 2));
	return file;
}

export function codexNotifyArgs(input: {
	shimPath: string;
	socketsDir: string;
	logsDir: string;
}): string[] {
	const notify = JSON.stringify([
		input.shimPath,
		"--provider",
		"codex",
		"--socket-dir",
		input.socketsDir,
		"--log-dir",
		input.logsDir,
	]);
	return ["-c", `notify=${notify}`];
}

export function claudeSettingsArgs(settingsFile: string): string[] {
	return ["--settings", settingsFile];
}

export type TurnEventsEnablement = { claude: boolean; codex: boolean };

export function resolveTurnEvents(flag: string | undefined): TurnEventsEnablement {
	const source = flag ?? process.env["AI_WHISPER_TURN_EVENTS"] ?? "";
	const set = new Set(source.split(",").map((s) => s.trim()).filter(Boolean));
	return { claude: set.has("claude"), codex: set.has("codex") };
}

export function formatTurnEventsStartupLine(e: TurnEventsEnablement): string {
	const on = (b: boolean) => (b ? "ON" : "off");
	return `[ai-whisper] turn-events: claude=${on(e.claude)} codex=${on(e.codex)} (codex notify-chaining: off)`;
}
