import {
	CURRENT_SCHEMA_VERSION,
	EVENT_PROTOCOL_VERSION,
} from "@ai-whisper/broker";
import { getStateRoot } from "../../runtime/state-root.js";
import {
	resolveCliVersion,
	resolveInstallPath,
} from "../../runtime/cli-package-info.js";
import {
	computeEvaluatorStatus,
	isEvaluatorReady,
	loadEvaluatorConfig,
	type EvaluatorStatus,
} from "../../runtime/evaluator-config.js";

// The contractual machine-readable answer to "are you there and can we talk?".
// Consumers validate this with zod; extra fields are tolerated, but these six
// are required with these exact names and types.
export interface WhisperEnvReport {
	engineVersion: string;
	installPath: string;
	stateRoot: string;
	dbSchemaVersion: number;
	protocolVersion: string;
	// Whether the LLM evaluator that gates the workflows has credentials. Lets an
	// external supervisor (e.g. ai-14all) warn that workflows will refuse to start
	// before the user tries one. `status` is the EvaluatorStatus reason;
	// `ready` is its boolean rollup.
	evaluator: { status: EvaluatorStatus; ready: boolean };
}

// Resolve evaluator readiness from config alone (auth.json/config.json/.env +
// process env), independent of any running daemon. orchestratorEnabled is forced
// true: `env` reports whether credentials are CONFIGURED, not whether some
// orchestrator is currently on (a daemon-runtime concern env has no basis to
// assert). A malformed config makes loadEvaluatorConfig throw; surface that as
// "invalid_config" — the same status computeEvaluatorStatus assigns a loader
// error — so `env` never crashes on bad config.
function buildEvaluatorReport(): { status: EvaluatorStatus; ready: boolean } {
	let status: EvaluatorStatus;
	try {
		status = computeEvaluatorStatus(loadEvaluatorConfig(), {
			orchestratorEnabled: true,
			loaderError: null,
		});
	} catch {
		status = "invalid_config";
	}
	return { status, ready: isEvaluatorReady(status) };
}

// No DB access, no network, no daemon required. dbSchemaVersion is a compile-time
// constant (never a DB read); protocolVersion is the same constant the socket
// fanout uses; stateRoot honors AI_WHISPER_STATE_ROOT. The evaluator block reads
// the config files under stateRoot (never the DB) to report credential readiness.
export function buildEnvReport(): WhisperEnvReport {
	return {
		engineVersion: resolveCliVersion(),
		installPath: resolveInstallPath(),
		stateRoot: getStateRoot(),
		dbSchemaVersion: CURRENT_SCHEMA_VERSION,
		protocolVersion: EVENT_PROTOCOL_VERSION,
		evaluator: buildEvaluatorReport(),
	};
}

export function renderEnvReportText(report: WhisperEnvReport): string {
	return [
		`engineVersion:   ${report.engineVersion}`,
		`installPath:     ${report.installPath}`,
		`stateRoot:       ${report.stateRoot}`,
		`dbSchemaVersion: ${report.dbSchemaVersion}`,
		`protocolVersion: ${report.protocolVersion}`,
		`evaluator:       ${report.evaluator.status} (ready=${report.evaluator.ready})`,
	].join("\n");
}
