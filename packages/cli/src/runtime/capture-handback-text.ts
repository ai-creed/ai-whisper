import type Database from "better-sqlite3";
import {
	acquireCaptureLease,
	releaseCaptureLease,
	type LeaseOptions,
} from "@ai-whisper/broker";
import {
	computeOrderedJaccard,
	computeContainment,
} from "./mounted-turn-owned-relay.js";

export type CaptureHandbackStatus = "captured" | "degraded_pty_only";

export interface CaptureHandbackResult {
	status: CaptureHandbackStatus;
	/** Captured clipboard text on success; null when degraded to PTY-only. */
	text: string | null;
	/** True when changeCount flagged a foreign write during the held window. */
	interferenceDetected: boolean;
}

/** Mutable, caller-owned holder for the agent's learned /copy changeCount
 *  signature (see captureHandbackText). One per mount; persists across captures. */
export interface CopySignature {
	delta: number | null;
}

export interface CaptureHandbackInput {
	db: Database.Database;
	collabId: string;
	pid: number;
	/** This collab's PTY turn text, used by the interference content check. */
	turnText: string;
	/** Runs one /copy injection + clipboard read; returns text or null. */
	runCapture: () => Promise<string | null>;
	/** Reads NSPasteboard.changeCount, or null when the helper is unavailable. */
	readChangeCount: () => Promise<number | null>;
	/** Per-mount learned /copy write-signature. A single /copy advances changeCount
	 *  by a fixed, agent-specific amount (codex = 1; Claude Code = 3, because its
	 *  /copy writes several pasteboard representations). Learned from the first
	 *  ownership-confirmed copy, then used as the clean-accept threshold so a
	 *  multi-write /copy is not mistaken for a foreign write. */
	copySignature?: CopySignature;
	leaseOptions?: LeaseOptions;
	/** Bounded poll-acquire. */
	acquireMaxWaitMs?: number;
	acquireBackoffMs?: number;
	/** Interference re-capture bound (default 2). */
	recaptureAttempts?: number;
	recaptureBackoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/** A clip this long, captured under the held lease, is trusted as the agent's own
 *  /copy when no PTY turnText is available to content-validate (Claude Code). */
const MIN_CALIBRATION_CHARS = 100;

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Content-acceptance check that BYPASSES the >=100-char fast-path. Accepts only
 *  on normalized identity or classifyCapture's similarity thresholds. */
function contentMatches(turnText: string, clip: string): boolean {
	const t = turnText.trim();
	const c = clip.trim();
	if (c.length === 0) return false;
	if (t === c) return true; // exact/normalized identity
	const jaccard = computeOrderedJaccard(t, c);
	const containment = computeContainment(c, t);
	return jaccard >= 0.6 || containment >= 0.8;
}

/**
 * Lease-wrapped clipboard capture. Acquires the host-global capture lease (or
 * degrades to PTY-only on timeout — never a racy read), snapshots changeCount
 * (C0), runs the /copy, re-reads changeCount (Cn).
 *
 * The clean-accept threshold is the agent's /copy write-SIGNATURE, not a hardcoded
 * 1: one /copy advances changeCount by a fixed agent-specific amount (codex 1;
 * Claude Code 3 — its /copy writes several pasteboard representations). `Cn-C0 <=
 * signature` ⇒ only our own /copy wrote ⇒ clean accept. `Cn-C0 > signature` ⇒ an
 * extra (foreign) write raced us ⇒ interference ladder (content-accept → re-capture
 * → PTY-only). The signature is learned from the first ownership-confirmed copy
 * (content-match, or — when there's no PTY turnText to match — a substantial clip
 * captured under the held lease). Releases in finally.
 */
export async function captureHandbackText(
	input: CaptureHandbackInput,
): Promise<CaptureHandbackResult> {
	const sleep = input.sleep ?? defaultSleep;
	const acquireMaxWaitMs = input.acquireMaxWaitMs ?? 4000;
	const acquireBackoffMs = input.acquireBackoffMs ?? 50;
	const recaptureAttempts = input.recaptureAttempts ?? 2;
	const recaptureBackoffMs = input.recaptureBackoffMs ?? 50;
	const sig = input.copySignature;

	// --- bounded poll-acquire; degrade to PTY-only on timeout (no racy read) ---
	let acquired = false;
	const deadline = Date.now() + acquireMaxWaitMs;
	for (;;) {
		try {
			acquired = acquireCaptureLease(
				input.db,
				input.collabId,
				input.pid,
				input.leaseOptions,
			);
		} catch {
			// Defense in depth: a residual SQLITE_BUSY ("database is locked") past
			// busy_timeout must not propagate — an uncaught throw here is swallowed
			// upstream into an empty handback that halts the workflow. Treat it as
			// "not acquired" and retry within the deadline, then degrade to PTY-only.
			acquired = false;
		}
		if (acquired) break;
		if (Date.now() >= deadline) break;
		await sleep(acquireBackoffMs);
	}
	if (!acquired) {
		return { status: "degraded_pty_only", text: null, interferenceDetected: false };
	}

	try {
		let interferenceDetected = false;
		// attempt 0 = initial capture; up to recaptureAttempts re-captures after.
		for (let attempt = 0; attempt <= recaptureAttempts; attempt += 1) {
			if (attempt > 0) await sleep(recaptureBackoffMs);

			const c0 = await input.readChangeCount();
			const clip = await input.runCapture();
			const cn = await input.readChangeCount();

			// changeCount unavailable on either read → skip the ownership check.
			const checkAvailable = c0 !== null && cn !== null;
			const delta = checkAvailable ? cn - c0 : null;
			// Clean iff the change is within our /copy's footprint. Default to 1
			// (a single pasteboard write) until the agent's signature is learned.
			const threshold = sig?.delta ?? 1;

			if (clip === null || clip.trim().length === 0) {
				// Empty capture. Three sub-cases:
				//  - delta > threshold: a foreign write clobbered our /copy before it
				//    landed → re-capture under the held lease.
				//  - delta === 0: the pasteboard did not change AT ALL since before our
				//    /copy, so our /copy has not LANDED yet (a slow provider /copy —
				//    e.g. codex serializing a large review). This is a read-before-write
				//    race, NOT a no-response: re-poll under the held lease rather than
				//    concluding no-change. Returning null here halted wf_292cb0933def440b
				//    (2026-06-08) — the empty clip was misclassified as a confident
				//    no-response and the code-review gate escalated. delta 0 is not a
				//    foreign write, so it must NOT set interferenceDetected.
				//  - otherwise (delta within 1..threshold, or changeCount unavailable):
				//    a genuine "no clipboard change" → return captured/null so the relay
				//    applies its no_response_captured* behavior.
				if (delta !== null && delta > threshold) {
					interferenceDetected = true;
					continue;
				}
				if (delta === 0 && attempt < recaptureAttempts) {
					continue; // /copy not landed yet — retry within the attempt budget
				}
				return { status: "captured", text: null, interferenceDetected };
			}

			if (delta === null || delta <= threshold) {
				// changeCount unavailable, or only our own /copy wrote → clean accept.
				return { status: "captured", text: clip, interferenceDetected };
			}

			// delta > threshold: either we haven't learned this agent's signature yet
			// (its /copy writes more than one representation), or a real foreign write
			// raced us. Confirm ownership, and on success LEARN the signature so the
			// next capture treats this delta as clean.
			interferenceDetected = true;
			if (contentMatches(input.turnText, clip)) {
				if (sig && sig.delta === null) sig.delta = delta;
				return { status: "captured", text: clip, interferenceDetected: true };
			}
			// No PTY turnText to content-match (Claude Code) and no signature yet:
			// under the held lease a substantial clip is our own /copy, not a foreign
			// write. Trust it, and calibrate the signature from it. (Agents WITH
			// turnText fall through to the foreign-write reject below — unchanged.)
			if (
				sig?.delta == null &&
				input.turnText.trim().length === 0 &&
				clip.trim().length >= MIN_CALIBRATION_CHARS
			) {
				if (sig) sig.delta = delta;
				return { status: "captured", text: clip, interferenceDetected: true };
			}
			// Signature known and exceeded with no content match → genuine foreign
			// write → fall through to re-capture.
		}
		// Every attempt showed a foreign write and never content-validated.
		return { status: "degraded_pty_only", text: null, interferenceDetected: true };
	} finally {
		releaseCaptureLease(input.db, input.collabId);
	}
}
