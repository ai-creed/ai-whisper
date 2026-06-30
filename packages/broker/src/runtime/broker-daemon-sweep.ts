import type Database from "better-sqlite3";
import {
	deleteBrokerDaemonByCollab,
	listStaleBrokerDaemons,
} from "../storage/repositories/broker-daemon-repository.js";

export type IsAliveResult = { alive: boolean; startTime: string | null };

export async function sweepStaleBrokerDaemons(input: {
	db: Database.Database;
	cutoffIso: string;
	isAlive: (pid: number) => Promise<IsAliveResult>;
}): Promise<{ deleted: number }> {
	const stale = listStaleBrokerDaemons(input.db, input.cutoffIso);
	let deleted = 0;
	for (const row of stale) {
		if (row.pid === null) {
			deleteBrokerDaemonByCollab(input.db, row.collabId);
			deleted += 1;
			continue;
		}
		const { alive, startTime } = await input.isAlive(row.pid);
		if (!alive) {
			deleteBrokerDaemonByCollab(input.db, row.collabId);
			deleted += 1;
			continue;
		}
		if (
			row.pidStartTime !== null &&
			startTime !== null &&
			startTime !== row.pidStartTime
		) {
			deleteBrokerDaemonByCollab(input.db, row.collabId);
			deleted += 1;
			continue;
		}
		// alive + start_time matches (or both unknown): heartbeat stalled. Leave row.
	}
	return { deleted };
}

/**
 * Synchronous liveness primitive: process.kill(pid, 0) probes the process
 * without signaling it. ESRCH ⇒ the pid does not exist (dead); EPERM ⇒ it
 * exists but we may not signal it (alive); anything else ⇒ treat as dead.
 * PID reuse cannot be detected here, so a recycled pid reads alive — the safe
 * direction for purge (skip, never wrongly delete a live collab).
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return true;
		return false;
	}
}

export function defaultIsAlive(pid: number): Promise<IsAliveResult> {
	return Promise.resolve({ alive: isPidAlive(pid), startTime: null });
}
