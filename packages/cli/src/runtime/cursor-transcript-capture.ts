import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	computeContainment,
	computeOrderedJaccard,
} from "./mounted-turn-owned-relay.js";
import type { CaptureHandbackResult } from "./capture-handback-text.js";

// ---------------------------------------------------------------------------
// Cursor mounted-handback capture.
//
// Cursor's `/copy` is an interactive picker, so the relay's clipboard capture
// can't drive it. Instead, on quiescence we read Cursor's on-disk session
// transcript (`~/.cursor/projects/<project>/agent-transcripts/<session>/<…>.jsonl`)
// and return the turn's last assistant text as the handback. Selection is by
// newest-mtime + turnText content-match — the project dir name is NOT a reversible
// transform of cwd (long paths are truncated+hashed), so we never derive it.
//
// The relay can call this BEFORE Cursor has finished (its quiescence may fire
// during the model's first-token latency). So the capture is gated on turn
// COMPLETION: it waits for a `{"type":"turn_ended"}` marker after the last user
// entry (or a stable assistant response) before extracting, and returns
// `timed_out` while the turn is still in flight so the relay's retry ladder gives
// Cursor more time rather than handing back an empty deliverable.
// ---------------------------------------------------------------------------

export interface TranscriptRef {
	path: string;
	mtimeMs: number;
}

type TranscriptEntry = {
	role?: unknown;
	type?: unknown;
	message?: { content?: unknown };
};

function parseEntry(line: string): TranscriptEntry | null {
	try {
		const value: unknown = JSON.parse(line);
		if (value && typeof value === "object") return value as TranscriptEntry;
		return null;
	} catch {
		return null;
	}
}

function textPartsOf(entry: TranscriptEntry): string[] {
	const content = entry.message?.content;
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content as unknown[]) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text"
		) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") out.push(text);
		}
	}
	return out;
}

export interface TurnAnalysis {
	/** An assistant entry exists after the last user entry (the turn has begun). */
	hasAssistant: boolean;
	/** A `turn_ended` marker follows the last user entry (the turn is complete). */
	turnEnded: boolean;
	/** Joined assistant text after the last user entry (the turn's deliverable). */
	text: string;
}

/**
 * Classify the latest turn in a transcript: whether the agent has started
 * responding, whether the turn has ended, and the assistant text it produced
 * (every assistant text block after the last `user` entry, joined; tool-call
 * entries contribute nothing). Malformed lines are skipped.
 */
export function analyzeTurn(jsonl: string): TurnAnalysis {
	const entries: TranscriptEntry[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const entry = parseEntry(trimmed);
		if (entry) entries.push(entry);
	}

	let lastUser = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i]?.role === "user") {
			lastUser = i;
			break;
		}
	}

	let hasAssistant = false;
	let turnEnded = false;
	const texts: string[] = [];
	for (let i = lastUser + 1; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.type === "turn_ended") {
			turnEnded = true;
			continue;
		}
		if (entry.role === "assistant") {
			hasAssistant = true;
			texts.push(...textPartsOf(entry));
		}
	}
	return { hasAssistant, turnEnded, text: texts.join("\n").trim() };
}

/**
 * The turn's deliverable: the assistant text after the last user entry. Thin
 * wrapper over analyzeTurn, retained for callers/tests that only want the text.
 */
export function extractLastAssistantText(jsonl: string): string {
	return analyzeTurn(jsonl).text;
}

export interface ListCursorTranscriptsSeams {
	home?: string;
	/** Returns the entry names of a directory; throws/absent dirs are skipped. */
	readDir?: (dir: string) => string[];
	/** Returns mtime (ms) for a file. */
	statMtimeMs?: (path: string) => number;
}

/**
 * All Cursor session transcripts on disk, newest-mtime first. Walks
 * `<home>/.cursor/projects/<project>/agent-transcripts/<session>/<file>.jsonl`.
 * ~/.cursor only holds Cursor sessions, so a concurrently-mounted claude/codex
 * never appears here.
 */
export function listCursorTranscripts(
	seams: ListCursorTranscriptsSeams = {},
): TranscriptRef[] {
	const home = seams.home ?? homedir();
	const readDir = seams.readDir ?? ((dir: string) => readdirSync(dir));
	const statMtimeMs = seams.statMtimeMs ?? ((path: string) => statSync(path).mtimeMs);

	const root = join(home, ".cursor", "projects");
	const refs: TranscriptRef[] = [];

	let projects: string[];
	try {
		projects = readDir(root);
	} catch {
		return [];
	}
	for (const project of projects) {
		const transcriptsDir = join(root, project, "agent-transcripts");
		let sessions: string[];
		try {
			sessions = readDir(transcriptsDir);
		} catch {
			continue;
		}
		for (const session of sessions) {
			const sessionDir = join(transcriptsDir, session);
			let files: string[];
			try {
				files = readDir(sessionDir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(sessionDir, file);
				try {
					refs.push({ path, mtimeMs: statMtimeMs(path) });
				} catch {
					// unreadable file — skip
				}
			}
		}
	}

	refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return refs;
}

function turnTextMatches(text: string, turn: string): boolean {
	return computeContainment(text, turn) >= 0.8 || computeOrderedJaccard(text, turn) >= 0.6;
}
function turnTextScore(text: string, turn: string): number {
	return Math.max(computeContainment(text, turn), computeOrderedJaccard(text, turn));
}

export interface SelectTranscriptInput {
	refs: TranscriptRef[];
	turnText: string;
	readFile: (path: string) => string;
	limit?: number;
}

/**
 * Among the newest `limit` transcripts, pick the one whose assistant text best
 * matches `turnText`; with no turnText or no match, fall back to the newest-mtime
 * transcript that has assistant text. Returns null when none have assistant text.
 * (Retained for direct use/tests; the live capture uses pickActiveTranscript so
 * it can also see in-flight turns.)
 */
export function selectTranscript(
	input: SelectTranscriptInput,
): { path: string; text: string } | null {
	const limit = input.limit ?? 5;
	const candidates = input.refs
		.slice(0, limit)
		.map((ref) => ({ path: ref.path, text: extractLastAssistantText(input.readFile(ref.path)) }))
		.filter((candidate) => candidate.text.length > 0);
	if (candidates.length === 0) return null;

	const turn = input.turnText.trim();
	if (turn.length > 0) {
		let best: { path: string; text: string } | null = null;
		let bestScore = -1;
		for (const candidate of candidates) {
			if (!turnTextMatches(candidate.text, turn)) continue;
			const score = turnTextScore(candidate.text, turn);
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		if (best) return best;
	}
	return candidates[0] ?? null;
}

/**
 * Pick the transcript representing the active turn — like selectTranscript, but
 * returns the full analysis (including in-flight/empty turns) so the caller can
 * wait for completion. Prefers a turnText-matching candidate with assistant text;
 * otherwise the newest-mtime transcript (which is the one being written during a
 * live turn).
 */
function pickActiveTranscript(
	refs: TranscriptRef[],
	turnText: string,
	readFile: (path: string) => string,
	limit: number,
): { path: string; analysis: TurnAnalysis } | null {
	const top = refs
		.slice(0, limit)
		.map((ref) => ({ path: ref.path, analysis: analyzeTurn(readFile(ref.path)) }));
	if (top.length === 0) return null;

	const turn = turnText.trim();
	if (turn.length > 0) {
		let best: { path: string; analysis: TurnAnalysis } | null = null;
		let bestScore = -1;
		for (const candidate of top) {
			if (candidate.analysis.text.length === 0) continue;
			if (!turnTextMatches(candidate.analysis.text, turn)) continue;
			const score = turnTextScore(candidate.analysis.text, turn);
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		if (best) return best;
	}
	return top[0] ?? null;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface CaptureCursorHandbackInput {
	/** This turn's PTY scrape; used to disambiguate concurrent transcripts. */
	turnText: string;
	/** Per-mount holder of the last delivered handback hash (freshness guard). */
	lastDelivered: { hash: string | null };
	// Seams (default to real fs / timers):
	listTranscripts?: () => TranscriptRef[];
	readFile?: (path: string) => string;
	sleep?: (ms: number) => Promise<void>;
	/** Total poll budget; keep under the relay's capture watchdog (20s). */
	budgetMs?: number;
	pollIntervalMs?: number;
	/** Identical reads (no turn_ended) to treat a turn as complete. */
	stabilityPolls?: number;
	selectLimit?: number;
}

/**
 * Quiescence-handback capture for a mounted Cursor session. Returns the same
 * CaptureHandbackResult shape the relay consumes for every provider.
 *
 * Polls the active transcript until the turn is COMPLETE — a `turn_ended` marker
 * after the last user entry, or an assistant response that has been byte-stable
 * across `stabilityPolls` reads (covers turns that don't emit the marker):
 *
 *  - completed, new text   → { captured, text }              (marker advanced)
 *  - completed, dup/empty  → { captured, text: null }        (relay no-response)
 *  - still in flight        → { timed_out }                   (relay retry ladder)
 *  - no transcript at all   → { degraded_pty_only }           (relay PTY fallback)
 *
 * Returning timed_out (rather than an empty handback) is the fix for Cursor's
 * model latency: the relay retries instead of escalating on an empty deliverable.
 * Never throws into the relay.
 */
export async function captureCursorHandback(
	input: CaptureCursorHandbackInput,
): Promise<CaptureHandbackResult> {
	const listTranscripts = input.listTranscripts ?? (() => listCursorTranscripts());
	const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const budgetMs = input.budgetMs ?? 15_000;
	const pollIntervalMs = input.pollIntervalMs ?? 500;
	const stabilityPolls = input.stabilityPolls ?? 4;
	const limit = input.selectLimit ?? 5;
	const maxPolls = Math.max(1, Math.ceil(budgetMs / pollIntervalMs));

	let sawTranscript = false;
	let prevText: string | null = null;
	let stableCount = 0;

	for (let attempt = 0; attempt < maxPolls; attempt += 1) {
		if (attempt > 0) await sleep(pollIntervalMs);

		let refs: TranscriptRef[];
		try {
			refs = listTranscripts();
		} catch {
			refs = [];
		}
		if (refs.length === 0) {
			prevText = null;
			stableCount = 0;
			continue;
		}
		sawTranscript = true;

		let pick: { path: string; analysis: TurnAnalysis } | null;
		try {
			pick = pickActiveTranscript(refs, input.turnText, readFile, limit);
		} catch {
			pick = null;
		}
		if (!pick || !pick.analysis.hasAssistant) {
			// Turn hasn't started yet — reset stability tracking and wait.
			prevText = null;
			stableCount = 0;
			continue;
		}

		const { turnEnded, text } = pick.analysis;
		if (text === prevText && text.length > 0) {
			stableCount += 1;
		} else {
			prevText = text;
			stableCount = 0;
		}
		const stableComplete = text.length > 0 && stableCount >= stabilityPolls;

		if (turnEnded || stableComplete) {
			if (text.length === 0) {
				// Turn ended with no prose (e.g. tool-only) → no-response.
				return { status: "captured", text: null, interferenceDetected: false };
			}
			const hash = sha256(text);
			if (hash === input.lastDelivered.hash) {
				// Same as the last handback (re-poll / repeated turn) → no-response.
				return { status: "captured", text: null, interferenceDetected: false };
			}
			input.lastDelivered.hash = hash;
			return { status: "captured", text, interferenceDetected: false };
		}
		// Assistant is mid-response — keep polling.
	}

	if (sawTranscript) {
		// The turn never completed within the budget — let the relay's retry ladder
		// give Cursor more time rather than handing back an empty/partial deliverable.
		return { status: "timed_out", text: null, interferenceDetected: false };
	}
	// Never found a transcript (not flushed / unreadable). Degrade to the PTY
	// scrape so a transcript hiccup never stalls the run.
	return { status: "degraded_pty_only", text: null, interferenceDetected: false };
}
