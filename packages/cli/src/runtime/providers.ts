import {
	createClaudeLiveSession,
	createClaudeProvider,
} from "@ai-whisper/adapter-claude";
import {
	createCodexLiveSession,
	createCodexProvider,
} from "@ai-whisper/adapter-codex";
import {
	createAiEzioLiveSession,
	createAiEzioProvider,
} from "@ai-whisper/adapter-ai-ezio";
import type { AgentType, InteractiveSessionController } from "@ai-whisper/shared";
import { getLiveSessionBrokerTempRoot } from "./paths.js";

export type MountTarget = AgentType;

export function getInteractiveSessionExecArgsForTarget(
	target: MountTarget,
	turnEvents?: { claudeSettingsFile?: string; codexNotify?: string[] },
): string[] {
	const tempRoot = getLiveSessionBrokerTempRoot();

	// ai-ezio is protocol-native: the harness owns the engine spawn, so there are
	// no provider CLI exec args.
	if (target === "ezio") {
		return [];
	}

	if (target === "codex") {
		// Full autonomy: the relay drives codex unattended, so it must run
		// with no approval prompts and no sandbox gating.
		const base = ["--dangerously-bypass-approvals-and-sandbox", "--add-dir", tempRoot];
		return turnEvents?.codexNotify ? [...base, ...turnEvents.codexNotify] : base;
	}

	// Full autonomy: bypass all permission checks so the relay can drive
	// claude unattended (file writes + bash).
	const base = ["--add-dir", tempRoot, "--dangerously-skip-permissions"];
	return turnEvents?.claudeSettingsFile
		? [...base, "--settings", turnEvents.claudeSettingsFile]
		: base;
}

export function getProviderExecArgsForTarget(target: MountTarget): string[] {
	const tempRoot = getLiveSessionBrokerTempRoot();

	if (target === "ezio") {
		return [];
	}

	if (target === "codex") {
		return [
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--add-dir",
			tempRoot,
		];
	}

	return ["-p", "--add-dir", tempRoot, "--dangerously-skip-permissions"];
}

export function createProviderForTarget(target: MountTarget) {
	if (target === "ezio") {
		return createAiEzioProvider();
	}
	if (target === "codex") {
		return createCodexProvider({
			executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
			execArgs: getProviderExecArgsForTarget("codex"),
		});
	}
	return createClaudeProvider({
		executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
		execArgs: getProviderExecArgsForTarget("claude"),
	});
}

export function createInteractiveSessionForTarget(input: {
	target: MountTarget;
	cwd: string;
	stdout: NodeJS.WritableStream;
	replyTimeoutMs?: number;
	/**
	 * Extra args forwarded after `--` to the agent binary (e.g. `--full-auto`
	 * for codex). Appended verbatim to the base interactive exec args; no
	 * shell escaping — they land directly in the spawn's argv.
	 */
	passthroughArgs?: string[];
	/**
	 * Turn-event injection config. When provided, appends the provider-specific
	 * hook flags (claude: `--settings <file>`, codex: `-c notify=<json>`) so
	 * the provider fires the shim on each turn completion.
	 */
	turnEvents?: { claudeSettingsFile?: string; codexNotify?: string[] };
}): InteractiveSessionController {
	if (input.target === "ezio") {
		// Protocol-native: the harness Session spawns hax in mounted posture; the
		// adapter renders the streamed assistant deltas to the operator's stdout.
		return createAiEzioLiveSession({ stdout: input.stdout });
	}
	const baseExecArgs = getInteractiveSessionExecArgsForTarget(input.target, input.turnEvents);
	const execArgs = [...baseExecArgs, ...(input.passthroughArgs ?? [])];
	if (input.target === "codex") {
		return createCodexLiveSession({
			config: {
				executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
				execArgs,
			},
			cwd: input.cwd,
			stdout: input.stdout,
			...(input.replyTimeoutMs !== undefined
				? { replyTimeoutMs: input.replyTimeoutMs }
				: {}),
		});
	}
	return createClaudeLiveSession({
		config: {
			executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
			execArgs,
		},
		cwd: input.cwd,
		stdout: input.stdout,
		...(input.replyTimeoutMs !== undefined
			? { replyTimeoutMs: input.replyTimeoutMs }
			: {}),
	});
}

