import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { acquireCaptureLease } from "../packages/broker/src/storage/clipboard-capture-lease.ts";
import { captureHandbackText } from "../packages/cli/src/runtime/capture-handback-text.ts";
import { CaptureIoTimeoutError } from "../packages/cli/src/runtime/clipboard-handback-capture.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "capwrap-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	return db;
}

const leaseOptions = { isPidAlive: () => true, ttlMs: 5000, now: () => 0 };
const baseDeps = {
	collabId: "collabA",
	pid: 100,
	turnText: "The verdict is approved because all tests pass and coverage holds.",
	leaseOptions,
};

describe("captureHandbackText — clean path", () => {
	it("returns captured text and no interference when changeCount delta is +1", async () => {
		const db = freshDb();
		let cc = 10;
		const result = await captureHandbackText({
			db,
			...baseDeps,
			runCapture: async () => {
				cc += 1; // our single /copy advances changeCount by exactly 1
				return "A long captured clipboard response that exceeds one hundred characters in length, trusted by the fast path.";
			},
			readChangeCount: async () => cc,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toContain("long captured clipboard response");
		expect(result.interferenceDetected).toBe(false);
	});
});

describe("captureHandbackText — serialization", () => {
	it("a second collab cannot capture while the first holds the lease", async () => {
		const db = freshDb();
		expect(acquireCaptureLease(db, "collabA", 100, leaseOptions)).toBeTruthy();

		const result = await captureHandbackText({
			db,
			collabId: "collabB",
			pid: 200,
			turnText: "irrelevant",
			leaseOptions,
			acquireMaxWaitMs: 50,
			acquireBackoffMs: 10,
			sleep: async () => {},
			runCapture: async () => "should never run",
			readChangeCount: async () => 1,
		});
		expect(result.status).toBe("lease_unavailable");
		expect(result.text).toBeNull();
	});
});

describe("captureHandbackText — degrade path", () => {
	it("acquire timeout degrades to PTY-only with no racy read", async () => {
		const db = freshDb();
		acquireCaptureLease(db, "other", 999, leaseOptions);
		let captureCalled = false;
		const result = await captureHandbackText({
			db,
			...baseDeps,
			acquireMaxWaitMs: 30,
			acquireBackoffMs: 10,
			sleep: async () => {},
			runCapture: async () => {
				captureCalled = true;
				return "x";
			},
			readChangeCount: async () => 1,
		});
		expect(result.status).toBe("lease_unavailable");
		expect(result.interferenceDetected).toBe(false);
		expect(captureCalled).toBe(false); // never proceed to a racy read
	});
});

describe("captureHandbackText — interference ladder", () => {
	it("re-captures on delta > 1, then content-accepts a matching re-capture", async () => {
		const db = freshDb();
		let cc = 10;
		let attempt = 0;
		const result = await captureHandbackText({
			db,
			...baseDeps,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				attempt += 1;
				if (attempt === 1) {
					cc += 2; // human ⌘C interleaved → delta 2
					return "Some completely unrelated foreign clipboard text from a human copy action here.";
				}
				cc += 1; // clean re-capture
				return baseDeps.turnText; // identity match to the PTY turn text
			},
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe(baseDeps.turnText);
	});

	it("rejects a foreign >=100-char copy under detected interference (regression guard)", async () => {
		const db = freshDb();
		let cc = 10;
		const foreignLong =
			"This is a foreign human clipboard payload that is well over one hundred characters long but is NOT this collab's answer at all.";
		const result = await captureHandbackText({
			db,
			...baseDeps,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				cc += 2; // every attempt shows interference
				return foreignLong; // >=100 chars but fails similarity vs turnText
			},
		});
		// Fast-path bypassed in interference path: length alone must NOT accept.
		expect(result.status).toBe("degraded_pty_only");
		expect(result.interferenceDetected).toBe(true);
		expect(result.text).not.toBe(foreignLong);
	});
});

describe("captureHandbackText — multi-write /copy signature (Claude Code)", () => {
	// Root cause: one /copy advances NSPasteboard.changeCount by a fixed
	// agent-specific amount — codex 1, but Claude Code 3 (it writes several
	// pasteboard representations). The hardcoded `delta == 1` clean gate flagged
	// claude's own /copy as "interference", and with no PTY turnText to content-
	// match, the genuine response was rejected → halt. The fix LEARNS the agent's
	// /copy signature and uses it as the clean threshold; a foreign write (delta >
	// signature) is still detected.
	const claudeResponse =
		"The implementation plan at /Users/x/ezio-smoke/docs/spec.plan.md is finalized with two TDD tasks covering the slugify pipeline and its edge cases.";

	it("calibrates the signature from the first /copy and accepts it (delta 3, empty turnText)", async () => {
		const db = freshDb();
		let cc = 100;
		const sig: { delta: number | null } = { delta: null };
		const result = await captureHandbackText({
			db,
			collabId: "collabA",
			pid: 100,
			turnText: "", // Claude Code: PTY turn text is never scraped
			copySignature: sig,
			leaseOptions,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				cc += 3; // one /copy = three pasteboard writes
				return claudeResponse;
			},
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe(claudeResponse);
		expect(sig.delta).toBe(3); // signature learned for next time
	});

	it("treats delta == learned signature as clean on later captures", async () => {
		const db = freshDb();
		let cc = 100;
		const sig: { delta: number | null } = { delta: 3 }; // already calibrated
		const result = await captureHandbackText({
			db,
			collabId: "collabA",
			pid: 100,
			turnText: "",
			copySignature: sig,
			leaseOptions,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				cc += 3;
				return claudeResponse;
			},
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe(claudeResponse);
		expect(result.interferenceDetected).toBe(false); // delta 3 <= signature 3
	});

	it("still detects a foreign write (delta > signature) after calibration", async () => {
		const db = freshDb();
		let cc = 100;
		const sig: { delta: number | null } = { delta: 3 };
		const result = await captureHandbackText({
			db,
			collabId: "collabA",
			pid: 100,
			turnText: "",
			copySignature: sig,
			leaseOptions,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				cc += 4; // exceeds the learned signature of 3 → a foreign write raced us
				return "y".repeat(150);
			},
		});
		expect(result.status).toBe("degraded_pty_only");
		expect(result.interferenceDetected).toBe(true);
	});
});

describe("captureHandbackText — genuine empty capture (no clipboard change)", () => {
	it("returns captured/null (NOT degraded) when capture is empty and changeCount is clean", async () => {
		const db = freshDb();
		const cc = 10; // no change → delta 0, not interference
		const result = await captureHandbackText({
			db,
			...baseDeps,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => null, // provider produced no clipboard output
		});
		// Genuine no-output → relay applies existing no_response_* behavior, no PTY degrade.
		expect(result.status).toBe("captured");
		expect(result.text).toBeNull();
		expect(result.interferenceDetected).toBe(false);
	});

	it("returns captured/null when capture is empty and changeCount is unavailable", async () => {
		const db = freshDb();
		const result = await captureHandbackText({
			db,
			...baseDeps,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => null, // helper unavailable
			runCapture: async () => "", // empty
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBeNull();
		expect(result.interferenceDetected).toBe(false);
	});
});

describe("captureHandbackText — slow /copy read-before-write race (Bug 2026-06-08)", () => {
	// wf_292cb0933def440b halted at the code-review gate: codex's /copy was slow to
	// land, so the first pbpaste read came back EMPTY while NSPasteboard.changeCount
	// had not advanced at all (delta 0, no foreign write). The old code treated an
	// empty clip + delta 0 as a GENUINE "no clipboard change" and returned
	// captured/null immediately — misclassifying a read-before-write race as a
	// no-response and halting the workflow. When changeCount shows NO movement, the
	// /copy simply has not landed yet, so re-poll under the held lease before
	// concluding no-change.
	it("re-polls on an empty capture with NO changeCount movement, then captures the late-landing clip", async () => {
		const db = freshDb();
		let cc = 10;
		let attempt = 0;
		const lateClip =
			"The reviewer's verdict: approved. All acceptance rows pass and the committed tests cover the exact contract conditions.";
		const result = await captureHandbackText({
			db,
			...baseDeps,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				attempt += 1;
				if (attempt < 2) return null; // /copy has not landed → changeCount unchanged
				cc += 1; // codex's /copy finally writes the pasteboard
				return lateClip;
			},
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe(lateClip);
		expect(result.interferenceDetected).toBe(false); // delta 0 is not a foreign write
	});
});

describe("captureHandbackText — changeCount helper absent", () => {
	it("skips the ownership check and accepts a clean long capture when readChangeCount returns null", async () => {
		const db = freshDb();
		const result = await captureHandbackText({
			db,
			...baseDeps,
			readChangeCount: async () => null, // helper unavailable
			runCapture: async () =>
				"A long captured clipboard response exceeding one hundred characters that the lease guarantees is ours.",
		});
		expect(result.status).toBe("captured");
		expect(result.interferenceDetected).toBe(false);
	});
});

describe("captureHandbackText — lock resilience (defense in depth)", () => {
	it("degrades to PTY-only (no throw) when lease acquire hits 'database is locked'", async () => {
		// Even after the IMMEDIATE-transaction fix, an extreme/sustained lock can
		// still surface SQLITE_BUSY past busy_timeout. The poll loop must treat a
		// throwing acquire as "not acquired" and degrade — never let it propagate
		// to a swallowed exception that empties the handback and halts the workflow.
		const throwLocked = () => {
			throw new Error("database is locked");
		};
		(throwLocked as unknown as { immediate: () => never }).immediate =
			throwLocked as () => never;
		const lockedDb = {
			transaction: () => throwLocked,
		} as unknown as Parameters<typeof captureHandbackText>[0]["db"];

		let captureCalled = false;
		const result = await captureHandbackText({
			db: lockedDb,
			...baseDeps,
			acquireMaxWaitMs: 30,
			acquireBackoffMs: 10,
			sleep: async () => {},
			runCapture: async () => {
				captureCalled = true;
				return "should never run";
			},
			readChangeCount: async () => 1,
		});
		expect(result.status).toBe("lease_unavailable");
		expect(result.text).toBeNull();
		expect(captureCalled).toBe(false);
	});
});

describe("captureHandbackText — pbpaste timeout", () => {
	it("returns status timed_out (not a throw, not degraded) when runCapture times out, AND releases the lease", async () => {
		const db = freshDb();
		const result = await captureHandbackText({
			db,
			...baseDeps,
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => 10,
			runCapture: async () => {
				throw new CaptureIoTimeoutError("pbpaste");
			},
		});
		expect(result.status).toBe("timed_out");
		expect(result.text).toBeNull();
		// Spec: the finally must release the lease (token-scoped) even on a timeout —
		// a later acquire by a DIFFERENT collab must succeed (no lease leak). With
		// leaseOptions.now() === 0 and ttlMs 5000, a still-held collabA lease would
		// block this acquire, so a truthy token proves the row was cleared.
		expect(acquireCaptureLease(db, "collabB", 200, leaseOptions)).toBeTruthy();
	});

	it("still propagates a NON-timeout throw from runCapture, AND releases the lease", async () => {
		const db = freshDb();
		await expect(
			captureHandbackText({
				db,
				...baseDeps,
				recaptureAttempts: 0,
				sleep: async () => {},
				readChangeCount: async () => 10,
				runCapture: async () => {
					throw new Error("some other failure");
				},
			}),
		).rejects.toThrow("some other failure");
		// Spec: even when the error propagates, the finally must have released the
		// lease before the throw escaped — prove it with a later acquire (no leak).
		expect(acquireCaptureLease(db, "collabB", 200, leaseOptions)).toBeTruthy();
	});
});

describe("captureHandbackText — orphan timeline (controlled-time lease TTL boundary)", () => {
	// The watchdog/TTL timing RELATIONSHIP, driven with an injected clock: a retry
	// while a watchdog-abandoned orphan still holds the lease (age < TTL) must get
	// lease_unavailable WITHOUT double-capturing; a retry past TTL must reclaim the
	// orphan and make forward progress. This is the lease-side half of the spec's
	// orphan-timeline requirement (the relay-side no-double-deliver/no-PTY half is in
	// test/pty-idle-auto-handback.test.ts).
	const ORPHAN_TTL = 25_000;
	const ORPHAN_T0 = Date.parse("2026-06-21T00:00:00Z");

	it("age BETWEEN watchdog and TTL: a retry gets lease_unavailable and does NOT double-capture", async () => {
		const db = freshDb();
		// Simulate the watchdog-abandoned orphan still holding the lease (never released).
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: ORPHAN_TTL,
				now: () => ORPHAN_T0,
			}),
		).toBeTruthy();
		let runCaptureCalls = 0;
		const result = await captureHandbackText({
			db,
			collabId: "collabA",
			pid: 100,
			turnText: "irrelevant",
			leaseOptions: {
				isPidAlive: () => true,
				ttlMs: ORPHAN_TTL,
				now: () => ORPHAN_T0 + 22_000, // 22s: BETWEEN the 20000 watchdog and the 25000 TTL
			},
			acquireMaxWaitMs: 30,
			acquireBackoffMs: 10,
			sleep: async () => {},
			runCapture: async () => {
				runCaptureCalls += 1;
				return "should never run";
			},
			readChangeCount: async () => 1,
		});
		expect(result.status).toBe("lease_unavailable");
		expect(runCaptureCalls).toBe(0); // no concurrent /copy while the orphan holds the lease
	});

	it("age PAST TTL: a retry reclaims the orphan's lease and makes forward progress (captured)", async () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: ORPHAN_TTL,
				now: () => ORPHAN_T0,
			}),
		).toBeTruthy();
		let cc = 5;
		const result = await captureHandbackText({
			db,
			collabId: "collabA",
			pid: 100,
			turnText: "",
			leaseOptions: {
				isPidAlive: () => true,
				ttlMs: ORPHAN_TTL,
				now: () => ORPHAN_T0 + 26_000, // 26s: past the 25000 TTL → orphan reclaimable
			},
			recaptureAttempts: 2,
			recaptureBackoffMs: 1,
			sleep: async () => {},
			readChangeCount: async () => cc,
			runCapture: async () => {
				cc += 1;
				return "A clean post-wake capture exceeding one hundred characters so the lease-held fast path trusts it as this collab's own.";
			},
		});
		expect(result.status).toBe("captured");
	});
});
