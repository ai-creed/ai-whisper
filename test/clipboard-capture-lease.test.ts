import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	acquireCaptureLease,
	releaseCaptureLease,
	releaseCaptureLeaseForHolderPid,
	sweepStaleCaptureLease,
} from "../packages/broker/src/storage/clipboard-capture-lease.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "lease-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	return db;
}

const TTL_MS = 5000;
const T0 = Date.parse("2026-05-25T00:00:00Z");

describe("clipboard_capture_lease — schema", () => {
	it("creates the singleton lease table via migration", () => {
		const db = freshDb();
		const row = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='clipboard_capture_lease'",
			)
			.get() as { name: string } | undefined;
		expect(row?.name).toBe("clipboard_capture_lease");
	});

	it("enforces the singleton id constraint (only id=1 allowed)", () => {
		const db = freshDb();
		expect(() =>
			db
				.prepare(
					"INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at) VALUES (2, 'c', 1, '2026-05-25T00:00:00Z')",
				)
				.run(),
		).toThrow();
	});
});

describe("relay_capture_diagnostics — interference column", () => {
	it("adds interference_detected with a default of 0", () => {
		const db = freshDb();
		const cols = db
			.prepare("PRAGMA table_info(relay_capture_diagnostics)")
			.all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
		const col = cols.find((c) => c.name === "interference_detected");
		expect(col).toBeDefined();
		expect(col?.notnull).toBe(1);
		expect(col?.dflt_value).toBe("0");
	});
});

describe("clipboard_capture_lease — acquire/release", () => {
	it("acquires when free", () => {
		const db = freshDb();
		const ok = acquireCaptureLease(db, "collabA", 100, {
			isPidAlive: () => true,
			ttlMs: TTL_MS,
			now: () => T0,
		});
		expect(ok).toBeTruthy();
	});

	it("blocks a second holder while the first is live and within TTL", () => {
		const db = freshDb();
		const opts = { isPidAlive: () => true, ttlMs: TTL_MS, now: () => T0 };
		expect(acquireCaptureLease(db, "collabA", 100, opts)).toBeTruthy();
		expect(acquireCaptureLease(db, "collabB", 200, opts)).toBeNull();
	});

	it("reclaims when the holder pid is dead", () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).toBeTruthy();
		// collabA's pid (100) is dead; collabB (200) is alive.
		expect(
			acquireCaptureLease(db, "collabB", 200, {
				isPidAlive: (pid) => pid === 200,
				ttlMs: TTL_MS,
				now: () => T0 + 10,
			}),
		).toBeTruthy();
	});

	it("reclaims when acquired_at exceeds TTL even if pid is alive", () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).toBeTruthy();
		expect(
			acquireCaptureLease(db, "collabB", 200, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0 + TTL_MS + 1,
			}),
		).toBeTruthy();
	});

	it("release clears the holder so the next acquire succeeds", () => {
		const db = freshDb();
		const opts = { isPidAlive: () => true, ttlMs: TTL_MS, now: () => T0 };
		const token = acquireCaptureLease(db, "collabA", 100, opts);
		expect(token).toBeTruthy();
		releaseCaptureLease(db, "collabA", token as string);
		expect(acquireCaptureLease(db, "collabB", 200, opts)).toBeTruthy();
	});

	it("release by a non-holder is a no-op (does not free another's lease)", () => {
		const db = freshDb();
		const opts = { isPidAlive: () => true, ttlMs: TTL_MS, now: () => T0 };
		const token = acquireCaptureLease(db, "collabA", 100, opts);
		expect(token).toBeTruthy();
		releaseCaptureLease(db, "collabB", token as string); // not the holder
		expect(acquireCaptureLease(db, "collabB", 200, opts)).toBeNull();
	});
});

describe("clipboard_capture_lease — startup sweep", () => {
	it("applyMigrations reclaims a stale singleton row left by a dead pid", () => {
		const db = freshDb();
		// Seed a held lease whose holder pid is (assumed) dead.
		db.prepare(
			"INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at) VALUES (1, 'deadCollab', 999999, '2026-05-25T00:00:00Z')",
		).run();
		// applyMigrations runs the sweep; the row's pid is long dead, so it clears.
		applyMigrations(db);
		const row = db
			.prepare("SELECT holder_collab_id FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_collab_id: string | null };
		expect(row.holder_collab_id).toBeNull();
	});

	it("sweepStaleCaptureLease leaves a live, within-TTL holder untouched", () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).toBeTruthy();
		sweepStaleCaptureLease(db, {
			isPidAlive: () => true,
			ttlMs: TTL_MS,
			now: () => T0 + 1,
		});
		const row = db
			.prepare("SELECT holder_collab_id FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_collab_id: string | null };
		expect(row.holder_collab_id).toBe("collabA");
	});
});

describe("clipboard_capture_lease — concurrent-writer safety (halted-workflow repro)", () => {
	it("does not throw 'database is locked' when another connection commits mid-acquire", () => {
		// Root cause of the halted-workflow capture failures. acquireCaptureLease
		// ran as a DEFERRED transaction (SELECT, then write the lease row). In WAL
		// mode the read→write promotion fails with an *immediate* SQLITE_BUSY —
		// busy_timeout is NOT honored for lock promotions — the instant any other
		// connection commits after the read snapshot. With multiple mount processes
		// sharing state.db that is constant, so the auto-handback capture threw
		// "database is locked", the throw was swallowed, and the workflow halted
		// with "No handbackText provided". The fix is BEGIN IMMEDIATE (take the
		// write lock up front), which makes busy_timeout apply again.
		const path = join(mkdtempSync(join(tmpdir(), "lease-race-")), "broker.sqlite");
		const dbA = openDatabase(path);
		applyMigrations(dbA);
		const connB = openDatabase(path);
		connB.pragma("busy_timeout = 1"); // fail fast once the fix holds the write lock

		let injected = false;
		const injectExternalCommit = () => {
			if (injected) return;
			injected = true;
			try {
				// A real competing writer commits between A's read snapshot and A's
				// write. Under DEFERRED this succeeds (A holds only a read lock) and
				// makes A's snapshot stale so A's promotion throws. Under IMMEDIATE
				// this throws (A already holds the write lock) and is swallowed — we
				// only assert on acquireCaptureLease itself.
				connB
					.prepare(
						"INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at) VALUES (1, 'connB', 1, '2026-05-25T00:00:00Z') ON CONFLICT(id) DO UPDATE SET holder_collab_id = 'connB'",
					)
					.run();
			} catch {
				/* expected once the fix takes the write lock first */
			}
		};

		// Proxy dbA so the lease upsert fires connB's commit immediately before A's
		// own write/promotion — deterministically forcing the production race.
		const proxyDb = new Proxy(dbA, {
			get(target, prop) {
				if (prop === "prepare") {
					return (sql: string) => {
						const stmt = target.prepare(sql);
						if (!sql.includes("INSERT INTO clipboard_capture_lease")) return stmt;
						return new Proxy(stmt, {
							get(s, p) {
								if (p === "run") {
									const realRun = (s.run as (...a: unknown[]) => unknown).bind(s);
									return (...args: unknown[]) => {
										injectExternalCommit();
										return realRun(...args);
									};
								}
								const v = (s as unknown as Record<PropertyKey, unknown>)[p];
								return typeof v === "function"
									? (v as (...a: unknown[]) => unknown).bind(s)
									: v;
							},
						});
					};
				}
				const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
				return typeof value === "function"
					? (value as (...a: unknown[]) => unknown).bind(target)
					: value;
			},
		});

		expect(() =>
			acquireCaptureLease(proxyDb as unknown as typeof dbA, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).not.toThrow();

		dbA.close();
		connB.close();
	});
});

describe("clipboard_capture_lease — token + pid scoping (timeout/watchdog reconciliation)", () => {
	const WATCHDOG_TTL = 25_000;

	it("does NOT reclaim a live holder still within the raised TTL (settling capture)", () => {
		const db = freshDb();
		// A capture legitimately holding for ~16s (two L1 exec timeouts) is < 25s TTL.
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: WATCHDOG_TTL,
				now: () => T0,
			}),
		).toBeTruthy();
		expect(
			acquireCaptureLease(db, "collabB", 200, {
				isPidAlive: () => true,
				ttlMs: WATCHDOG_TTL,
				now: () => T0 + 16_000,
			}),
		).toBeNull();
	});

	it("token-scoped release: a stale-token release is a no-op against a newer lease", () => {
		const db = freshDb();
		const tokenA = acquireCaptureLease(db, "collabA", 100, {
			isPidAlive: () => true,
			ttlMs: 5000,
			now: () => T0,
		});
		expect(tokenA).toBeTruthy();
		// collabA aged out; collabA re-acquires (its own retry) → a NEW token.
		const tokenB = acquireCaptureLease(db, "collabA", 100, {
			isPidAlive: () => true,
			ttlMs: 5000,
			now: () => T0 + 6000,
		});
		expect(tokenB).toBeTruthy();
		expect(tokenB).not.toBe(tokenA);
		// The orphan's late release with the OLD token must NOT clear B's lease.
		releaseCaptureLease(db, "collabA", tokenA as string);
		const row = db
			.prepare("SELECT acquired_at FROM clipboard_capture_lease WHERE id = 1")
			.get() as { acquired_at: string | null };
		expect(row.acquired_at).toBe(tokenB);
		// Releasing with the CURRENT token clears it.
		releaseCaptureLease(db, "collabA", tokenB as string);
		const cleared = db
			.prepare("SELECT holder_collab_id FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_collab_id: string | null };
		expect(cleared.holder_collab_id).toBeNull();
	});

	it("pid-scoped teardown release frees only this mount's lease, not a different-pid holder", () => {
		const db = freshDb();
		// A reconnected mount (same collab, different pid) holds the lease.
		expect(
			acquireCaptureLease(db, "collabA", 200, {
				isPidAlive: () => true,
				ttlMs: 5000,
				now: () => T0,
			}),
		).toBeTruthy();
		// The OLD mount (pid 100) tears down; its pid-scoped release must be a no-op.
		releaseCaptureLeaseForHolderPid(db, "collabA", 100);
		const still = db
			.prepare("SELECT holder_pid FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_pid: number | null };
		expect(still.holder_pid).toBe(200);
		// The matching-pid teardown clears it.
		releaseCaptureLeaseForHolderPid(db, "collabA", 200);
		const cleared = db
			.prepare("SELECT holder_collab_id FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_collab_id: string | null };
		expect(cleared.holder_collab_id).toBeNull();
	});
});
