import { CURRENT_SCHEMA_VERSION, EVENT_PROTOCOL_VERSION } from "@ai-whisper/broker";
import { getStateRoot } from "../../runtime/state-root.js";
import {
	resolveCliVersion,
	resolveInstallPath,
} from "../../runtime/cli-package-info.js";

// The contractual machine-readable answer to "are you there and can we talk?".
// Consumers validate this with zod; extra fields are tolerated, but these five
// are required with these exact names and types.
export interface WhisperEnvReport {
	engineVersion: string;
	installPath: string;
	stateRoot: string;
	dbSchemaVersion: number;
	protocolVersion: string;
}

// Pure: no DB access, no network, no daemon required. dbSchemaVersion is a
// compile-time constant (never a DB read); protocolVersion is the same constant
// the socket fanout uses; stateRoot honors AI_WHISPER_STATE_ROOT.
export function buildEnvReport(): WhisperEnvReport {
	return {
		engineVersion: resolveCliVersion(),
		installPath: resolveInstallPath(),
		stateRoot: getStateRoot(),
		dbSchemaVersion: CURRENT_SCHEMA_VERSION,
		protocolVersion: EVENT_PROTOCOL_VERSION,
	};
}

export function renderEnvReportText(report: WhisperEnvReport): string {
	return [
		`engineVersion:   ${report.engineVersion}`,
		`installPath:     ${report.installPath}`,
		`stateRoot:       ${report.stateRoot}`,
		`dbSchemaVersion: ${report.dbSchemaVersion}`,
		`protocolVersion: ${report.protocolVersion}`,
	].join("\n");
}
