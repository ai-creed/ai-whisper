import { readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

type ControlMethods = {
	sweepCaptureDiagnostics(input: { cutoffIso: string }): number;
	sweepEvaluatorDiagnostics(input: { cutoffIso: string }): number;
	sweepTurnEventDiagnostics(input: { cutoffIso: string }): number;
};

export type DiagnosticsSweepDeps = {
	broker: { control: ControlMethods };
	/** Override the sweep interval in ms. Defaults to env or 1h. */
	intervalMs?: number;
	/** Override the retention window in days. Defaults to env or 30. */
	retentionDays?: number;
	/** Override the event-log file retention in days. Defaults to env or 3. */
	eventLogRetentionDays?: number;
	/** Path to the logs/ dir for dated turn-event JSONL files. */
	logsDir?: string;
};

export type DiagnosticsSweep = {
	start(): void;
	stop(): void;
};

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_EVENT_LOG_RETENTION_DAYS = 3;
const TURN_EVENT_FILE_RE = /^turn-events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function resolveIntervalMs(override: number | undefined): number {
	if (override !== undefined) return override;
	const envVal = process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"];
	if (envVal && Number.isFinite(Number(envVal))) return Number(envVal);
	return DEFAULT_INTERVAL_MS;
}

function resolveRetentionDays(override: number | undefined): number {
	if (override !== undefined) return override;
	const envVal = process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"];
	if (envVal && Number.isFinite(Number(envVal))) return Number(envVal);
	return DEFAULT_RETENTION_DAYS;
}

export function resolveEventLogRetentionDays(override?: number): number {
	if (override !== undefined) return override;
	const raw = process.env["AI_WHISPER_EVENT_LOG_RETENTION_DAYS"];
	if (raw && Number.isFinite(Number(raw)) && Number(raw) > 0) return Number(raw);
	return DEFAULT_EVENT_LOG_RETENTION_DAYS;
}

// Unlink whole dated files older than cutoffDate (YYYY-MM-DD). Returns paths removed.
export function sweepTurnEventLogs(logsDir: string, cutoffDate: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(logsDir);
	} catch {
		return []; // dir not created yet — nothing to sweep
	}
	const removed: string[] = [];
	for (const name of entries) {
		const m = TURN_EVENT_FILE_RE.exec(name);
		if (!m) continue;
		if (m[1]! < cutoffDate) {
			const full = join(logsDir, name);
			try {
				statSync(full);
				unlinkSync(full);
				removed.push(full);
			} catch {
				// already gone — ignore
			}
		}
	}
	return removed;
}

export function createDiagnosticsSweep(deps: DiagnosticsSweepDeps): DiagnosticsSweep {
	const intervalMs = resolveIntervalMs(deps.intervalMs);
	const retentionDays = resolveRetentionDays(deps.retentionDays);
	let timer: ReturnType<typeof setInterval> | null = null;

	function tick(): void {
		const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
		const cutoffIso = cutoff.toISOString();
		deps.broker.control.sweepCaptureDiagnostics({ cutoffIso });
		deps.broker.control.sweepEvaluatorDiagnostics({ cutoffIso });
		const eventRetentionDays = resolveEventLogRetentionDays(deps.eventLogRetentionDays);
		const eventCutoff = new Date(Date.now() - eventRetentionDays * 86_400_000);
		deps.broker.control.sweepTurnEventDiagnostics({ cutoffIso: eventCutoff.toISOString() });
		if (deps.logsDir) {
			sweepTurnEventLogs(deps.logsDir, eventCutoff.toISOString().slice(0, 10));
		}
	}

	return {
		start(): void {
			if (timer !== null) return;
			timer = setInterval(tick, intervalMs);
		},
		stop(): void {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
