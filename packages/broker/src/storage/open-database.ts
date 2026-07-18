import Database from "better-sqlite3";

export interface OpenDatabaseOptions {
	/** PRAGMA busy_timeout value: how long a single contended statement or
	 *  BEGIN waits inside SQLite before failing with SQLITE_BUSY. */
	busyTimeoutMs?: number;
	/** Upper bound on how long a queued transaction keeps retrying a
	 *  contended BEGIN (across busy_timeout expiries) before rethrowing. */
	maxWriteWaitMs?: number;
}

const RETRYABLE_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"]);

/** Blocks the thread for ms. Same semantics as SQLite's own busy handler,
 *  which also sleeps the calling thread while it waits for a lock. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Re-runs a whole transaction while it fails with a retryable lock error,
 *  backing off until the deadline. Restarting at the transaction boundary is
 *  the only correct granularity for SQLITE_BUSY_SNAPSHOT: the restart takes
 *  a fresh snapshot. Transaction bodies may therefore run more than once —
 *  better-sqlite3 has already rolled back before we re-attempt. */
function runQueued<T>(input: {
	attempt: () => T;
	busyTimeoutMs: number;
	maxWriteWaitMs: number;
	setBusyTimeoutMs: (ms: number) => void;
}): T {
	const deadline = Date.now() + input.maxWriteWaitMs;
	let backoffMs = 10;
	try {
		for (;;) {
			// Cap how long SQLite may block THIS attempt to the remaining
			// write-wait budget — otherwise a busyTimeoutMs larger than
			// maxWriteWaitMs would overshoot the deadline inside a single
			// BEGIN before the loop ever gets to check it.
			input.setBusyTimeoutMs(
				Math.max(1, Math.min(input.busyTimeoutMs, deadline - Date.now())),
			);
			try {
				return input.attempt();
			} catch (err) {
				const code = (err as { code?: string }).code;
				if (code === undefined || !RETRYABLE_CODES.has(code) || Date.now() >= deadline) {
					throw err;
				}
				sleepSync(Math.min(backoffMs, Math.max(1, deadline - Date.now())));
				backoffMs = Math.min(backoffMs * 2, 250);
			}
		}
	} finally {
		// Later statements outside the queue must see the configured value,
		// not whatever cap the final attempt ran under.
		input.setBusyTimeoutMs(input.busyTimeoutMs);
	}
}

export function openDatabase(
	path: string,
	options?: OpenDatabaseOptions,
): Database.Database {
	const busyTimeoutMs = options?.busyTimeoutMs ?? 5000;
	const maxWriteWaitMs = options?.maxWriteWaitMs ?? 30_000;
	const db = new Database(path);
	// WAL lets concurrent readers proceed without blocking writers; busy_timeout
	// makes writers wait for a held lock instead of failing with SQLITE_BUSY.
	// Multiple processes (broker daemon, mount commands, relay-monitor) share
	// this file, so both pragmas are required to avoid startup-race crashes.
	db.pragma("journal_mode = WAL");
	db.pragma(`busy_timeout = ${busyTimeoutMs}`);

	// busy_timeout cannot save a DEFERRED read-then-write transaction: its
	// snapshot is taken at the first read, and once another connection commits,
	// the write upgrade fails immediately with SQLITE_BUSY_SNAPSHOT — waiting
	// cannot refresh a stale snapshot mid-transaction. So every transaction
	// function created from this connection runs BEGIN IMMEDIATE by default
	// (write lock before the first read; contenders queue on busy_timeout)
	// under a bounded retry queue that restarts the whole transaction on
	// SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT until maxWriteWaitMs. Writers wait
	// for each other instead of crashing.
	//
	// The wrapper is loosely typed internally: @types/better-sqlite3 types
	// transaction params with its own ArgumentTypes<F> conditional that TS
	// will not unify with Parameters<F>. The single cast on the assignment
	// below restores the public db.transaction signature unchanged.
	type AnyFn = (...args: unknown[]) => unknown;
	const createTransaction = db.transaction.bind(db);
	const queuedTransaction = (fn: AnyFn) => {
		const txn = createTransaction(fn);
		const runVariant = (variant: AnyFn, params: unknown[]): unknown =>
			db.inTransaction
				? // Nested call: better-sqlite3 runs it as a savepoint inside the
					// outer transaction. It must never retry independently — only the
					// outermost transaction owns restart semantics.
					txn(...params)
				: runQueued({
						attempt: () => variant(...params),
						busyTimeoutMs,
						maxWriteWaitMs,
						setBusyTimeoutMs: (ms) => {
							db.pragma(`busy_timeout = ${ms}`);
						},
					});

		const immediate = (...params: unknown[]) =>
			runVariant(txn.immediate.bind(txn), params);
		return Object.assign((...params: unknown[]) => immediate(...params), {
			// `txn()` and `txn.default()` are the same invocation in
			// better-sqlite3; both now mean "immediate, queued".
			default: immediate,
			immediate,
			exclusive: (...params: unknown[]) =>
				runVariant(txn.exclusive.bind(txn), params),
			// Documented read-only opt-out: deferred transactions stay raw. A
			// body that writes after reading is exposed to SQLITE_BUSY_SNAPSHOT
			// again — only use this for multi-statement reads.
			deferred: txn.deferred.bind(txn),
		});
	};
	db.transaction = queuedTransaction as unknown as typeof db.transaction;
	return db;
}
