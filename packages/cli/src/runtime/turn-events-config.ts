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

/** Tokens `resolveTurnEvents` acts on: provider names + the disable controls. */
const RECOGNIZED_TURN_EVENTS_TOKENS = new Set(["claude", "codex", "off", "none"]);

function parseTurnEventsTokens(raw: string): string[] {
	return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function resolveTurnEvents(flag: string | undefined): TurnEventsEnablement {
	const raw = flag ?? process.env["AI_WHISPER_TURN_EVENTS"];
	// Unset (neither flag nor env present) → default ON for both PTY-scraped
	// providers. The event path is the primary capture methodology; the
	// clipboard `/copy` path remains as the automatic fallback.
	if (raw === undefined) return { claude: true, codex: true };
	// Explicitly set → allow-list. "off"/"none"/empty is the kill-switch that
	// reverts every provider to pure clipboard; a provider subset (e.g.
	// "claude") scopes the event path to exactly that set.
	const set = new Set(parseTurnEventsTokens(raw));
	if (set.has("off") || set.has("none")) return { claude: false, codex: false };
	return { claude: set.has("claude"), codex: set.has("codex") };
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
	return `[ai-whisper] turn-events: claude=${on(e.claude)} codex=${on(e.codex)} (codex notify-chaining: off)`;
}
