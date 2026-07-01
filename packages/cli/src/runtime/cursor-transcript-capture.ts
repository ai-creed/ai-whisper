import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	computeContainment,
	computeOrderedJaccard,
} from "./mounted-turn-owned-relay.js";
import type {
	CaptureHandbackResult,
	CaptureHandbackStatus,
} from "./capture-handback-text.js";

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

/** Parse a JSONL transcript into entries, skipping blank/malformed lines. */
function parseEntries(jsonl: string): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const entry = parseEntry(trimmed);
		if (entry) entries.push(entry);
	}
	return entries;
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
	const entries = parseEntries(jsonl);

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

/**
 * The text of the last `role:"user"` entry — the instruction the relay delivered
 * to Cursor for this turn. This is the reliable selection anchor: it is written
 * verbatim from the delivered handoff and is stable across polls while the
 * assistant response streams. Empty when the transcript has no user entry.
 */
export function extractLastUserText(jsonl: string): string {
	const entries = parseEntries(jsonl);
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.role === "user") return textPartsOf(entry).join("\n").trim();
	}
	return "";
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

/**
 * Does a transcript's user-entry text correspond to the relay-delivered prompt?
 * Symmetric containment (either direction) tolerates any framing the relay wraps
 * around the instruction; ordered Jaccard covers reworded-but-similar cases.
 */
function promptMatches(userText: string, expected: string): boolean {
	const u = userText.trim();
	const e = expected.trim();
	if (u.length === 0 || e.length === 0) return false;
	return (
		computeContainment(u, e) >= 0.8 ||
		computeContainment(e, u) >= 0.8 ||
		computeOrderedJaccard(u, e) >= 0.6
	);
}
function promptScore(userText: string, expected: string): number {
	return Math.max(
		computeContainment(userText, expected),
		computeContainment(expected, userText),
		computeOrderedJaccard(userText, expected),
	);
}

export interface PromptPickResult {
	/** How many transcripts were considered (post-freshness, within the limit). */
	candidateCount: number;
	/** How many of those had a user entry matching the expected prompt. */
	matchedCount: number;
	/** The best-matching transcript's ref + analysis, or null when none matched. */
	pick: { path: string; analysis: TurnAnalysis } | null;
}

export interface PickByPromptInput {
	refs: TranscriptRef[];
	expectedPrompt: string;
	readFile: (path: string) => string;
	limit?: number;
}

/**
 * Select the transcript whose LAST user entry best matches `expectedPrompt` — the
 * instruction the relay delivered. Unlike assistant-text matching, the user entry
 * is stable across polls and unaffected by the noisy TUI scrape, so it reliably
 * identifies the active turn even amongst concurrent/stale transcripts.
 */
export function pickByPrompt(input: PickByPromptInput): PromptPickResult {
	const limit = input.limit ?? 5;
	const candidates = input.refs.slice(0, limit).map((ref) => {
		const jsonl = input.readFile(ref.path);
		return {
			path: ref.path,
			userText: extractLastUserText(jsonl),
			analysis: analyzeTurn(jsonl),
		};
	});
	const expected = input.expectedPrompt.trim();

	let best: { path: string; analysis: TurnAnalysis } | null = null;
	let bestScore = -1;
	let matchedCount = 0;
	for (const candidate of candidates) {
		if (!promptMatches(candidate.userText, expected)) continue;
		matchedCount += 1;
		const score = promptScore(candidate.userText, expected);
		if (score > bestScore) {
			bestScore = score;
			best = { path: candidate.path, analysis: candidate.analysis };
		}
	}
	return { candidateCount: candidates.length, matchedCount, pick: best };
}

/**
 * Drop transcripts last modified before the prompt was delivered (minus a clock-
 * skew allowance). This is the freshness floor that stops a prior run's transcript
 * — whose delivered instruction may be byte-identical to this run's — from being
 * selected. A no-op when `promptDeliveredAtMs` is unknown.
 */
export function applyFreshnessFloor(
	refs: TranscriptRef[],
	promptDeliveredAtMs: number | undefined,
	clockSkewMs: number,
): TranscriptRef[] {
	if (promptDeliveredAtMs === undefined) return refs;
	const floor = promptDeliveredAtMs - clockSkewMs;
	return refs.filter((ref) => ref.mtimeMs >= floor);
}

/** One capture-decision breadcrumb (persisted as JSONL by the mount wiring). */
export interface CursorCaptureTrace {
	/** Transcripts considered after the freshness floor. */
	candidateCount: number;
	/** Candidates whose user entry matched the expected prompt (0 when unused). */
	matchedCount: number;
	/** The chosen transcript path, or null when nothing was selected. */
	chosenPath: string | null;
	/** Length of the captured handback text (0 for no-response/degrade). */
	textLen: number;
	/** The resolved capture status. */
	status: CaptureHandbackStatus;
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
	/** This turn's PTY scrape; a fallback selection signal when no expectedPrompt. */
	turnText: string;
	/** The instruction the relay delivered — the primary selection anchor (matched
	 *  against each transcript's last user entry). Falls back to turnText when absent. */
	expectedPrompt?: string;
	/** When the prompt was delivered (ms epoch); enables the freshness floor so a
	 *  prior run's byte-identical transcript is not selected. */
	promptDeliveredAtMs?: number;
	/** Clock-skew allowance subtracted from the freshness floor (default 5s). */
	clockSkewMs?: number;
	/** Per-mount holder of the last delivered handback hash (freshness guard). */
	lastDelivered: { hash: string | null };
	/** Observability sink: one breadcrumb per capture resolution. */
	onTrace?: (trace: CursorCaptureTrace) => void;
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
	const clockSkewMs = input.clockSkewMs ?? 5_000;
	const expectedPrompt = input.expectedPrompt?.trim() ?? "";
	const maxPolls = Math.max(1, Math.ceil(budgetMs / pollIntervalMs));

	let sawTranscript = false;
	let prevText: string | null = null;
	let stableCount = 0;
	// Last-poll observability, emitted with the terminal result.
	let candidateCount = 0;
	let matchedCount = 0;
	let chosenPath: string | null = null;

	const finish = (
		status: CaptureHandbackStatus,
		text: string | null,
	): CaptureHandbackResult => {
		input.onTrace?.({
			candidateCount,
			matchedCount,
			chosenPath,
			textLen: text?.length ?? 0,
			status,
		});
		return { status, text, interferenceDetected: false };
	};

	for (let attempt = 0; attempt < maxPolls; attempt += 1) {
		if (attempt > 0) await sleep(pollIntervalMs);

		let allRefs: TranscriptRef[];
		try {
			allRefs = listTranscripts();
		} catch {
			allRefs = [];
		}
		// Freshness floor: never select a transcript last written before this
		// prompt was delivered (a prior run's, possibly byte-identical).
		const refs = applyFreshnessFloor(allRefs, input.promptDeliveredAtMs, clockSkewMs);
		candidateCount = refs.length;
		if (refs.length === 0) {
			prevText = null;
			stableCount = 0;
			continue;
		}
		sawTranscript = true;

		let pick: { path: string; analysis: TurnAnalysis } | null;
		try {
			if (expectedPrompt.length > 0) {
				// Anchor on the delivered instruction (the transcript's user entry) —
				// robust to the noisy TUI scrape and to concurrent/stale sessions.
				const result = pickByPrompt({ refs, expectedPrompt, readFile, limit });
				matchedCount = result.matchedCount;
				pick = result.pick;
			} else {
				// No delivered prompt available → fall back to assistant-text/newest.
				pick = pickActiveTranscript(refs, input.turnText, readFile, limit);
			}
		} catch {
			pick = null;
		}
		if (!pick || !pick.analysis.hasAssistant) {
			// Turn hasn't started (or no match yet) — reset stability and wait.
			prevText = null;
			stableCount = 0;
			continue;
		}
		chosenPath = pick.path;

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
				return finish("captured", null);
			}
			const hash = sha256(text);
			if (hash === input.lastDelivered.hash) {
				// Same as the last handback (re-poll / repeated turn) → no-response.
				return finish("captured", null);
			}
			input.lastDelivered.hash = hash;
			return finish("captured", text);
		}
		// Assistant is mid-response — keep polling.
	}

	if (sawTranscript) {
		// The turn never completed within the budget — let the relay's retry ladder
		// give Cursor more time rather than handing back an empty/partial deliverable.
		return finish("timed_out", null);
	}
	// Never found a transcript (not flushed / unreadable). Degrade to the PTY
	// scrape so a transcript hiccup never stalls the run.
	return finish("degraded_pty_only", null);
}
