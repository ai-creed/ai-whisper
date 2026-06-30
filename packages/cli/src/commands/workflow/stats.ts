import type { HandsOffStats } from "@ai-whisper/broker";
import { fmtDurCoarse } from "../../runtime/relay-view-state.js";

export interface WorkflowStatsDeps {
	broker: { control: { getHandsOffStats: () => HandsOffStats } };
	json?: boolean;
	stdout?: NodeJS.WritableStream;
}

/**
 * Render the accumulated hands-off time saved. Pure: it reads
 * `broker.control.getHandsOffStats()` and writes formatted output to
 * `deps.stdout` (default process.stdout). Opening the shared DB and stopping
 * the broker is the caller's responsibility (see create-cli.ts registration).
 */
export function runWorkflowStats(deps: WorkflowStatsDeps): void {
	const stats = deps.broker.control.getHandsOffStats();
	const out = deps.stdout ?? process.stdout;

	if (deps.json) {
		const payload = {
			totalMs: stats.totalMs,
			totalHuman: fmtDurCoarse(stats.totalMs),
			count: stats.count,
			since: stats.earliestKickoffAt,
			byStatus: {
				done: {
					count: stats.byStatus.done.count,
					totalMs: stats.byStatus.done.totalMs,
					human: fmtDurCoarse(stats.byStatus.done.totalMs),
				},
				halted: {
					count: stats.byStatus.halted.count,
					totalMs: stats.byStatus.halted.totalMs,
					human: fmtDurCoarse(stats.byStatus.halted.totalMs),
				},
			},
			skipped: stats.skipped,
		};
		out.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	if (stats.count === 0) {
		out.write("Hands-off time saved: 0m (no completed workflows yet)\n");
		return;
	}

	const since = (stats.earliestKickoffAt ?? "").slice(0, 10); // YYYY-MM-DD
	out.write(
		`Hands-off time saved: ${fmtDurCoarse(stats.totalMs)}  (${stats.count} workflows, since ${since})\n`,
	);
	for (const status of ["done", "halted"] as const) {
		const b = stats.byStatus[status];
		out.write(
			`  ${status.padEnd(9)}${b.count} runs · ${fmtDurCoarse(b.totalMs)}\n`,
		);
	}
}
