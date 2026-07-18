import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

// better-sqlite3 is a broker dependency, not hoisted to the repo root, so
// raw connections (and the worker thread) must resolve it from the broker
// package's own node_modules.
const brokerRequireBase = new URL("../packages/broker/package.json", import.meta.url);
type RawDatabase = ReturnType<typeof openDatabase>;
const Database = createRequire(brokerRequireBase)("better-sqlite3") as new (
	path: string,
) => RawDatabase;

// openDatabase wraps db.transaction so every transaction function runs
// BEGIN IMMEDIATE by default under a bounded retry queue: the write lock is
// taken before the first read (no deferred snapshot to go stale), and a
// contended BEGIN waits/retries until maxWriteWaitMs instead of crashing
// with SQLITE_BUSY_SNAPSHOT mid-handoff.

function freshPath(prefix: string): string {
	return join(mkdtempSync(join(tmpdir(), prefix)), "state.db");
}

describe("open-database write queue", () => {
	it("raw deferred read-then-write fails with SQLITE_BUSY_SNAPSHOT when another connection commits in between", () => {
		// Mechanism documentation with raw better-sqlite3 connections (no
		// wrapper): this is the exact failure mode handoffBackRelayTxn hit.
		const path = freshPath("raw-snapshot-");
		const a = new Database(path);
		a.pragma("journal_mode = WAL");
		const b = new Database(path);
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
		a.prepare("INSERT INTO t (id, v) VALUES (1, 0)").run();

		a.exec("BEGIN DEFERRED");
		a.prepare("SELECT v FROM t WHERE id = 1").get(); // read snapshot
		b.prepare("UPDATE t SET v = 1 WHERE id = 1").run(); // other-connection commit

		let code: string | undefined;
		try {
			a.prepare("UPDATE t SET v = 2 WHERE id = 1").run(); // write upgrade
		} catch (err) {
			code = (err as { code?: string }).code;
		} finally {
			a.exec("ROLLBACK");
		}
		expect(code).toBe("SQLITE_BUSY_SNAPSHOT");
		a.close();
		b.close();
	});

	it("default transaction invocation holds the write lock from BEGIN, so an interleaved writer gets SQLITE_BUSY instead of poisoning the snapshot", () => {
		const path = freshPath("default-immediate-");
		const a = openDatabase(path);
		// busyTimeoutMs: 0 so b's contended write fails fast instead of waiting.
		const b = openDatabase(path, { busyTimeoutMs: 0 });
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
		a.prepare("INSERT INTO t (id, v) VALUES (1, 0)").run();

		// Replays the exact bug schedule inside the txn body: read, then an
		// other-connection write, then our write. With deferred BEGIN the
		// other write lands and our UPDATE dies with SQLITE_BUSY_SNAPSHOT;
		// with immediate BEGIN the other write is the one turned away.
		let interleavedCode: string | undefined;
		const txn = a.transaction(() => {
			a.prepare("SELECT v FROM t WHERE id = 1").get();
			try {
				b.prepare("UPDATE t SET v = 100 WHERE id = 1").run();
			} catch (err) {
				interleavedCode = (err as { code?: string }).code;
			}
			a.prepare("UPDATE t SET v = 2 WHERE id = 1").run();
		});

		expect(() => txn()).not.toThrow();
		expect(interleavedCode).toBe("SQLITE_BUSY");
		const row = a.prepare("SELECT v FROM t WHERE id = 1").get() as { v: number };
		expect(row.v).toBe(2);
		a.close();
		b.close();
	});

	it("sees another connection's committed write when the wrapped transaction starts afterwards", () => {
		const path = freshPath("fresh-state-");
		const a = openDatabase(path);
		const b = openDatabase(path);
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
		a.prepare("INSERT INTO t (id, v) VALUES (1, 0)").run();

		// B commits BEFORE A's wrapped transaction begins; A must read the
		// fresh value — an immediate BEGIN takes its snapshot after the write
		// lock, so there is no stale snapshot to trip over.
		b.prepare("UPDATE t SET v = 100 WHERE id = 1").run();

		let seen: number | undefined;
		const txn = a.transaction(() => {
			const row = a.prepare("SELECT v FROM t WHERE id = 1").get() as { v: number };
			seen = row.v;
			a.prepare("UPDATE t SET v = ? WHERE id = 1").run(row.v + 1);
		});
		expect(() => txn()).not.toThrow();
		expect(seen).toBe(100);
		const after = a.prepare("SELECT v FROM t WHERE id = 1").get() as { v: number };
		expect(after.v).toBe(101);
		a.close();
		b.close();
	});

	it("waits for a lock held by another thread and succeeds once it is released", async () => {
		const path = freshPath("wait-succeed-");
		const setup = new Database(path);
		setup.pragma("journal_mode = WAL");
		setup.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
		setup.prepare("INSERT INTO t (id, v) VALUES (1, 0)").run();
		setup.close();

		// The holder thread takes BEGIN IMMEDIATE, signals, holds ~250ms,
		// commits +10, and exits. It runs in a worker because the main thread
		// blocks synchronously inside the wrapped transaction's retry queue.
		const sab = new SharedArrayBuffer(4);
		const flag = new Int32Array(sab);
		const worker = new Worker(
			[
				"const { workerData } = require('node:worker_threads');",
				"const { createRequire } = require('node:module');",
				"const Database = createRequire(workerData.requireBase)('better-sqlite3');",
				"const db = new Database(workerData.dbPath);",
				"db.pragma('busy_timeout = 5000');",
				"db.exec('BEGIN IMMEDIATE');",
				"db.prepare('UPDATE t SET v = v + 10 WHERE id = 1').run();",
				"const flag = new Int32Array(workerData.sab);",
				"Atomics.store(flag, 0, 1);",
				"Atomics.notify(flag, 0);",
				"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);",
				"db.exec('COMMIT');",
				"db.close();",
			].join("\n"),
			{
				eval: true,
				workerData: {
					dbPath: path,
					sab,
					holdMs: 250,
					requireBase: brokerRequireBase.href,
				},
			},
		);
		const workerExit = new Promise<void>((resolve, reject) => {
			worker.once("exit", () => resolve());
			worker.once("error", reject);
		});

		Atomics.wait(flag, 0, 0); // until the worker holds the write lock

		const a = openDatabase(path, { busyTimeoutMs: 25, maxWriteWaitMs: 5000 });
		const txn = a.transaction(() => {
			const row = a.prepare("SELECT v FROM t WHERE id = 1").get() as { v: number };
			a.prepare("UPDATE t SET v = ? WHERE id = 1").run(row.v + 1);
		});
		expect(() => txn()).not.toThrow();

		await workerExit;
		// Both the worker's +10 and our +1 landed: the queue waited, then ran
		// on a fresh snapshot.
		const row = a.prepare("SELECT v FROM t WHERE id = 1").get() as { v: number };
		expect(row.v).toBe(11);
		a.close();
	});

	it("gives up with SQLITE_BUSY once maxWriteWaitMs is exceeded", () => {
		const path = freshPath("deadline-");
		const a = openDatabase(path, { busyTimeoutMs: 20, maxWriteWaitMs: 200 });
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
		a.prepare("INSERT INTO t (id, v) VALUES (1, 0)").run();

		const holder = new Database(path);
		holder.exec("BEGIN IMMEDIATE"); // never released while we try

		const txn = a.transaction(() => {
			a.prepare("UPDATE t SET v = 1 WHERE id = 1").run();
		});
		const startedAt = Date.now();
		let code: string | undefined;
		try {
			txn();
		} catch (err) {
			code = (err as { code?: string }).code;
		}
		const elapsedMs = Date.now() - startedAt;
		holder.exec("ROLLBACK");

		expect(code).toBe("SQLITE_BUSY");
		// Bounded by maxWriteWaitMs (200ms), not the 5s pragma default and
		// not an unbounded hang.
		expect(elapsedMs).toBeLessThan(1000);
		a.close();
		holder.close();
	});

	it("caps each blocked attempt to the remaining budget when busyTimeoutMs exceeds maxWriteWaitMs", () => {
		const path = freshPath("inverse-timeouts-");
		// The inverse configuration: a single SQLite busy wait (1000ms) is
		// larger than the whole write-wait budget (25ms). The queue must cap
		// the per-attempt busy_timeout to the remaining budget, not let one
		// attempt block past the deadline.
		const a = openDatabase(path, { busyTimeoutMs: 1000, maxWriteWaitMs: 25 });
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
		a.prepare("INSERT INTO t (id, v) VALUES (1, 0)").run();

		const holder = new Database(path);
		holder.exec("BEGIN IMMEDIATE"); // never released while we try

		const txn = a.transaction(() => {
			a.prepare("UPDATE t SET v = 1 WHERE id = 1").run();
		});
		const startedAt = Date.now();
		let code: string | undefined;
		try {
			txn();
		} catch (err) {
			code = (err as { code?: string }).code;
		}
		const elapsedMs = Date.now() - startedAt;
		holder.exec("ROLLBACK");

		expect(code).toBe("SQLITE_BUSY");
		expect(elapsedMs).toBeLessThan(500);
		// The connection's configured busy_timeout is restored after the queue
		// gives up — later statements must not inherit a capped value.
		expect(a.pragma("busy_timeout", { simple: true })).toBe(1000);
		a.close();
		holder.close();
	});

	it("nested transaction calls run as savepoints inside the outer transaction", () => {
		const path = freshPath("nested-");
		const a = openDatabase(path);
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");

		const inner = a.transaction(() => {
			a.prepare("INSERT INTO t (id, v) VALUES (2, 20)").run();
		});
		const outer = a.transaction(() => {
			a.prepare("INSERT INTO t (id, v) VALUES (1, 10)").run();
			inner();
		});
		outer();
		const count = a.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
		expect(count.n).toBe(2);

		// An outer failure rolls the nested work back with it — the inner call
		// must not have committed (or retried) independently.
		const failingOuter = a.transaction(() => {
			a.prepare("INSERT INTO t (id, v) VALUES (3, 30)").run();
			inner(); // UNIQUE violation on id 2 → whole outer txn rolls back
		});
		expect(() => failingOuter()).toThrow();
		const after = a.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
		expect(after.n).toBe(2);
		a.close();
	});

	it("a nested transaction never retries independently of its outer transaction", () => {
		const path = freshPath("nested-retry-");
		const a = openDatabase(path);
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");

		// The inner body throws a retryable-coded error on the first outer
		// attempt. Restart semantics belong to the outermost transaction ONLY:
		// the whole outer transaction must re-run (both counters advance
		// together). A broken nested guard would retry the inner call by
		// itself and leave innerRuns > outerRuns.
		let outerRuns = 0;
		let innerRuns = 0;
		const inner = a.transaction(() => {
			innerRuns += 1;
			if (outerRuns === 1) {
				const err = new Error("synthetic busy") as Error & { code?: string };
				err.code = "SQLITE_BUSY";
				throw err;
			}
			a.prepare("INSERT INTO t (id, v) VALUES (2, 20)").run();
		});
		const outer = a.transaction(() => {
			outerRuns += 1;
			a.prepare("INSERT INTO t (id, v) VALUES (1, 10)").run();
			inner();
		});

		expect(() => outer()).not.toThrow();
		expect(outerRuns).toBe(2);
		expect(innerRuns).toBe(2);
		// The first attempt's partial work rolled back with the outer txn;
		// only the second attempt's rows exist.
		const count = a.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
		expect(count.n).toBe(2);
		a.close();
	});

	it("explicit .immediate() invocation keeps working for existing call sites", () => {
		const path = freshPath("explicit-immediate-");
		const a = openDatabase(path);
		a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");

		const txn = a.transaction((v: number) => {
			a.prepare("INSERT INTO t (v) VALUES (?)").run(v);
		});
		expect(() => txn.immediate(7)).not.toThrow();
		const row = a.prepare("SELECT v FROM t").get() as { v: number };
		expect(row.v).toBe(7);
		a.close();
	});
});
