import type Database from "better-sqlite3";
import { setBrokerDaemonEvaluatorStatus } from "@ai-whisper/broker";
import {
	computeEvaluatorStatus,
	type EvaluatorStatus,
	type ResolvedEvaluatorConfig,
} from "./evaluator-config.js";

const NOT_CONFIGURED: ResolvedEvaluatorConfig = {
	provider: "anthropic",
	fallback: null,
	anthropic: { apiKey: null, model: null },
	ollama: { host: null, model: null },
	openai: { apiKey: null, model: null, baseURL: null },
	agentCli: { agent: null, executable: null, execArgs: null, promptVia: null, model: null },
};

// Computes the daemon's evaluator readiness and persists it to the broker_daemon
// row. REQUIRED write (no optional chaining): if it silently no-op'd, the column
// would stay NULL → read as "unknown" → preflight false-passes. Runs even when
// the loader threw (loaderError set) so the row records invalid_config while the
// daemon stays up.
export function recordEvaluatorStatus(
	db: Database.Database,
	input: {
		collabId: string;
		resolved: ResolvedEvaluatorConfig | undefined;
		loaderError: Error | null;
		orchestratorEnabled: boolean;
	},
): Exclude<EvaluatorStatus, "unknown"> {
	const status = computeEvaluatorStatus(input.resolved ?? NOT_CONFIGURED, {
		orchestratorEnabled: input.orchestratorEnabled,
		loaderError: input.loaderError,
	});
	setBrokerDaemonEvaluatorStatus(db, { collabId: input.collabId, status });
	return status;
}
