import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
	if (raw === undefined) return { claude: true, codex: true, agy: true };
	const set = new Set(parseTurnEventsTokens(raw));
	if (set.has("off") || set.has("none"))
		return { claude: false, codex: false, agy: false };
	return { claude: set.has("claude"), codex: set.has("codex"), agy: set.has("agy") };
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

export const AGY_HOOKS_GROUP = "ai-whisper-turn-events";

export type AgyHooksScope = "workspace" | "global";

export function agyHooksFilePath(input: {
	scope: AgyHooksScope;
	workspaceRoot: string;
	home?: string;
}): string {
	return input.scope === "workspace"
		? join(input.workspaceRoot, ".agents", "hooks.json")
		: join(input.home ?? homedir(), ".gemini", "config", "hooks.json");
}

/**
 * Builds the `ai-whisper-turn-events` named group. The same shim is wired for all
 * five lifecycle events; each command carries `--workspace-id` (routing source —
 * agy payloads have no cwd) and `--event <Name>` (so the mount-side receiver can
 * distinguish Stop from the heartbeat events).
 *
 * Tool-scoped events (PreToolUse AND PostToolUse) MUST use the matcher form
 * `{ matcher, hooks }`. Verified against agy v1.0.13: agy fires tool-scoped hooks
 * only in the matcher form — the shorthand `{ type, command }` parses but silently
 * never fires. Registering PostToolUse in shorthand left the tool-in-flight bracket
 * (opened by PreToolUse, closed by PostToolUse) open forever, latching the idle
 * fallback off for the session. Non-tool events (Stop/PreInvocation/PostInvocation)
 * fire correctly in shorthand.
 */
export function buildAgyHooksGroup(input: {
	shimPath: string;
	socketsDir: string;
	logsDir: string;
	workspaceId: string;
	timeoutSeconds?: number;
}): Record<string, unknown> {
	const timeout = input.timeoutSeconds ?? 5;
	const cmd = (event: string) => ({
		type: "command",
		command: `${input.shimPath} --provider agy --socket-dir ${input.socketsDir} --log-dir ${input.logsDir} --workspace-id ${input.workspaceId} --event ${event}`,
		timeout,
	});
	return {
		Stop: [cmd("Stop")],
		PreInvocation: [cmd("PreInvocation")],
		PostInvocation: [cmd("PostInvocation")],
		PostToolUse: [{ matcher: "*", hooks: [cmd("PostToolUse")] }],
		PreToolUse: [{ matcher: "*", hooks: [cmd("PreToolUse")] }],
	};
}

function readHooksMap(filePath: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Non-destructive: merge/replace only the ai-whisper-turn-events group. */
export function writeAgyHooksFile(input: {
	filePath: string;
	group: Record<string, unknown>;
}): void {
	const map = readHooksMap(input.filePath);
	map[AGY_HOOKS_GROUP] = input.group;
	mkdirSync(dirname(input.filePath), { recursive: true });
	writeFileSync(input.filePath, JSON.stringify(map, null, 2));
}

/** Teardown: drop only our group; leave user-authored groups and the file intact. */
export function removeAgyHooksGroup(input: { filePath: string }): void {
	if (!existsSync(input.filePath)) return;
	const map = readHooksMap(input.filePath);
	if (!(AGY_HOOKS_GROUP in map)) return;
	delete map[AGY_HOOKS_GROUP];
	writeFileSync(input.filePath, JSON.stringify(map, null, 2));
}
