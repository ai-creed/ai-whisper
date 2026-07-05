import {
	createClaudeLiveSession,
	createClaudeProvider,
} from "@ai-whisper/adapter-claude";
import {
	createCodexLiveSession,
	createCodexProvider,
} from "@ai-whisper/adapter-codex";
import {
	createCursorLiveSession,
	createCursorProvider,
} from "@ai-whisper/adapter-cursor";
import {
	createAiEzioLiveSession,
	createAiEzioProvider,
} from "@ai-whisper/adapter-ai-ezio";
import {
	createAntigravityLiveSession,
	createAntigravityProvider,
} from "@ai-whisper/adapter-antigravity";
import type { AgentType, InteractiveSessionController, OverlayRunner } from "@ai-whisper/shared";
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

	if (target === "agy") {
		// Full autonomy, identical to claude. agy's turn-event hooks are registered
		// via a hooks.json file (writeAgyHooksFile), not argv, so no turn-event flag
		// is appended here.
		return ["--add-dir", tempRoot, "--dangerously-skip-permissions"];
	}

	if (target === "cursor") {
		// Full autonomy: --force (Cursor's --dangerously-* equivalent) lets the
		// relay drive `agent` unattended. Cursor has no --add-dir; --force already
		// grants unrestricted file access, so the broker temp root is reachable
		// without an allowlist flag. No turn-event hook flags (clipboard path).
		return ["--force"];
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

	if (target === "agy") {
		return ["-p", "--add-dir", tempRoot, "--dangerously-skip-permissions"];
	}

	if (target === "cursor") {
		// Headless one-shot: -p prints the result, --force grants full autonomy,
		// and --output-format json emits the single result envelope parse-cursor-
		// output consumes. No --add-dir (see interactive args above).
		return ["-p", "--force", "--output-format", "json"];
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
	if (target === "agy") {
		return createAntigravityProvider({
			executable: process.env.AI_WHISPER_AGY_CMD ?? "agy",
			execArgs: getProviderExecArgsForTarget("agy"),
		});
	}
	if (target === "cursor") {
		return createCursorProvider({
			executable: process.env.AI_WHISPER_CURSOR_CMD ?? "agent",
			execArgs: getProviderExecArgsForTarget("cursor"),
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
	/**
	 * Per-mode interactive overlay runner (ezio only). Wired lazily from the
	 * live-session runtime so the picker can borrow stdin raw-key access.
	 */
	runInteractiveOverlay?: OverlayRunner;
}): InteractiveSessionController {
	if (input.target === "ezio") {
		// Protocol-native: the harness Session spawns hax in mounted posture; the
		// adapter renders the streamed assistant deltas to the operator's stdout.
		return createAiEzioLiveSession({
			stdout: input.stdout,
			...(input.runInteractiveOverlay !== undefined
				? { runInteractiveOverlay: input.runInteractiveOverlay }
				: {}),
		});
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
	if (input.target === "agy") {
		return createAntigravityLiveSession({
			config: {
				executable: process.env.AI_WHISPER_AGY_CMD ?? "agy",
				execArgs,
			},
			cwd: input.cwd,
			stdout: input.stdout,
			...(input.replyTimeoutMs !== undefined
				? { replyTimeoutMs: input.replyTimeoutMs }
				: {}),
		});
	}
	if (input.target === "cursor") {
		return createCursorLiveSession({
			config: {
				executable: process.env.AI_WHISPER_CURSOR_CMD ?? "agent",
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

