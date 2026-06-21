import type Database from "better-sqlite3";

const LEASE_ID = 1;

/** Worst-case capture window (attempts × delayMs + trigger delay ≈ 1.3s today)
 *  plus headroom. A holder older than this is treated as crashed/stale. */
export const DEFAULT_LEASE_TTL_MS = 25000;

export interface LeaseOptions {
	/** Liveness probe; defaults to synchronous process.kill(pid, 0). */
	isPidAlive?: (pid: number) => boolean;
	/** Max hold before a lease is considered stale and reclaimable. */
	ttlMs?: number;
	/** Clock injection for deterministic tests. Returns epoch ms. */
	now?: () => number;
}

interface LeaseRow {
	holder_collab_id: string | null;
	holder_pid: number | null;
	acquired_at: string | null;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = dead. EPERM = alive but not signalable.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function resolveOptions(options: LeaseOptions): Required<LeaseOptions> {
	return {
		isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
		ttlMs: options.ttlMs ?? DEFAULT_LEASE_TTL_MS,
		now: options.now ?? Date.now,
	};
}

function isStale(row: LeaseRow, opts: Required<LeaseOptions>): boolean {
	if (row.holder_collab_id === null) return true; // free
	if (row.holder_pid === null || !opts.isPidAlive(row.holder_pid)) return true;
	if (row.acquired_at === null) return true;
	const age = opts.now() - Date.parse(row.acquired_at);
	return age > opts.ttlMs;
}

/**
 * Acquire the host-global capture lease for `collabId`/`pid`. Succeeds when the
 * lease is free or stale (dead holder pid, or acquired_at older than TTL). Runs
 * inside a single short write transaction — never held across the async capture.
 * Returns the `acquired_at` token on acquire (used as a fencing token by release),
 * or null when a live, within-TTL holder owns it.
 */
export function acquireCaptureLease(
	db: Database.Database,
	collabId: string,
	pid: number,
	options: LeaseOptions = {},
): string | null {
	const opts = resolveOptions(options);
	const tx = db.transaction((): string | null => {
		const row = db
			.prepare(
				"SELECT holder_collab_id, holder_pid, acquired_at FROM clipboard_capture_lease WHERE id = ?",
			)
			.get(LEASE_ID) as LeaseRow | undefined;

		if (row && !isStale(row, opts)) return null;

		const acquiredAt = new Date(opts.now()).toISOString();
		db.prepare(
			`INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   holder_collab_id = excluded.holder_collab_id,
			   holder_pid       = excluded.holder_pid,
			   acquired_at      = excluded.acquired_at`,
		).run(LEASE_ID, collabId, pid, acquiredAt);
		return acquiredAt;
	});
	// IMMEDIATE (not the default DEFERRED): take the write lock up front so
	// busy_timeout is honored. A DEFERRED transaction reads first (SELECT) then
	// promotes to a write lock (INSERT); in WAL mode that promotion fails with an
	// *immediate* SQLITE_BUSY ("database is locked") — busy_timeout does NOT cover
	// lock promotions — the moment any other connection commits after the read
	// snapshot. With multiple mount processes sharing state.db that race is
	// constant, and the throw was swallowed into an empty handback that halted the
	// workflow. IMMEDIATE eliminates the read→write promotion entirely.
	return tx.immediate();
}

/** Release the lease iff `collabId` holds it AND the token (the `acquired_at`
 *  returned by acquire) still matches — so a late orphan release cannot clear a
 *  newer lease the same collab acquired afterward. */
export function releaseCaptureLease(
	db: Database.Database,
	collabId: string,
	token: string,
): void {
	const tx = db.transaction(() => {
		db.prepare(
			"UPDATE clipboard_capture_lease SET holder_collab_id = NULL, holder_pid = NULL, acquired_at = NULL WHERE id = ? AND holder_collab_id = ? AND acquired_at = ?",
		).run(LEASE_ID, collabId, token);
	});
	tx();
}

/** Terminal cleanup: release the lease iff held by this collab AND this pid.
 *  Used on mount teardown, where there is no single acquisition token — pid
 *  scoping frees only THIS mount process's leases and cannot clobber a
 *  reconnected same-collab mount running under a different pid. */
export function releaseCaptureLeaseForHolderPid(
	db: Database.Database,
	collabId: string,
	pid: number,
): void {
	const tx = db.transaction(() => {
		db.prepare(
			"UPDATE clipboard_capture_lease SET holder_collab_id = NULL, holder_pid = NULL, acquired_at = NULL WHERE id = ? AND holder_collab_id = ? AND holder_pid = ?",
		).run(LEASE_ID, collabId, pid);
	});
	tx();
}

/**
 * Startup sweep: clear the lease if its current holder is stale (dead pid or
 * TTL-exceeded). Idempotent; safe to run on every broker startup.
 */
export function sweepStaleCaptureLease(
	db: Database.Database,
	options: LeaseOptions = {},
): void {
	const opts = resolveOptions(options);
	const tx = db.transaction(() => {
		const row = db
			.prepare(
				"SELECT holder_collab_id, holder_pid, acquired_at FROM clipboard_capture_lease WHERE id = ?",
			)
			.get(LEASE_ID) as LeaseRow | undefined;
		if (!row || row.holder_collab_id === null) return;
		if (isStale(row, opts)) {
			db.prepare(
				"UPDATE clipboard_capture_lease SET holder_collab_id = NULL, holder_pid = NULL, acquired_at = NULL WHERE id = ?",
			).run(LEASE_ID);
		}
	});
	tx();
}
