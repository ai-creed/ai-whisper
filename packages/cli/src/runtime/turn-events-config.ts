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

export type TurnEventsEnablement = { claude: boolean; codex: boolean; agy: boolean };

/** Tokens `resolveTurnEvents` acts on: provider names + the disable controls. */
const RECOGNIZED_TURN_EVENTS_TOKENS = new Set(["claude", "codex", "agy", "off", "none"]);

function parseTurnEventsTokens(raw: string): string[] {
	return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function resolveTurnEvents(flag: string | undefined): TurnEventsEnablement {
	const raw = flag ?? process.env["AI_WHISPER_TURN_EVENTS"];
	// agy has no turn-end hook, so it can never be enabled here regardless of the
	// flag; it is recognized only so the token is not flagged as a typo.
	if (raw === undefined) return { claude: true, codex: true, agy: false };
	const set = new Set(parseTurnEventsTokens(raw));
	if (set.has("off") || set.has("none")) return { claude: false, codex: false, agy: false };
	return { claude: set.has("claude"), codex: set.has("codex"), agy: false };
}

/**
 * True when the operator explicitly asked for `agy` turn-events. agy has no hook,
 * so the caller surfaces this as a loud "unsupported, staying off" warning.
 */
export function agyTurnEventsExplicitlyRequested(flag: string | undefined): boolean {
	const raw = flag ?? process.env["AI_WHISPER_TURN_EVENTS"];
	if (raw === undefined) return false;
	return new Set(parseTurnEventsTokens(raw)).has("agy");
}

/**
 * Tokens in the resolved --turn-events / AI_WHISPER_TURN_EVENTS value that are
 * neither a known provider nor a disable control. A typo here (e.g. "clade")
 * silently resolves to a provider being OFF, so the caller surfaces these as a
 * loud startup warning rather than letting the misconfiguration pass unnoticed.
 * Returns unique, lowercased tokens; empty when unset or fully recognized.
 */
export function unrecognizedTurnEventsTokens(flag: string | undefined): string[] {
	const raw = flag ?? process.env["AI_WHISPER_TURN_EVENTS"];
	if (raw === undefined) return [];
	const unknown = parseTurnEventsTokens(raw).filter(
		(t) => !RECOGNIZED_TURN_EVENTS_TOKENS.has(t),
	);
	return [...new Set(unknown)];
}

export function formatTurnEventsStartupLine(e: TurnEventsEnablement): string {
	const on = (b: boolean) => (b ? "ON" : "off");
	return `[ai-whisper] turn-events: claude=${on(e.claude)} codex=${on(e.codex)} agy=${on(e.agy)} (codex notify-chaining: off)`;
}
