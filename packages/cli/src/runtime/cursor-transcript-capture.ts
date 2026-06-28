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
// ---------------------------------------------------------------------------

export interface TranscriptRef {
	path: string;
	mtimeMs: number;
}

type TranscriptEntry = {
	role?: unknown;
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

/**
 * The turn's deliverable: every `role:"assistant"` text block that appears AFTER
 * the last `role:"user"` entry, joined with newlines. Tool-call entries
 * contribute nothing; a tool-call-only turn yields "". Malformed lines are
 * skipped. (User pick: join all assistant text blocks, not just the last.)
 */
export function extractLastAssistantText(jsonl: string): string {
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

	const texts: string[] = [];
	for (let i = lastUser + 1; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.role !== "assistant") continue;
		texts.push(...textPartsOf(entry));
	}
	return texts.join("\n").trim();
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

export interface SelectTranscriptInput {
	refs: TranscriptRef[];
	turnText: string;
	readFile: (path: string) => string;
	limit?: number;
}

/**
 * Among the newest `limit` transcripts, pick the one whose assistant text best
 * matches `turnText` (containment ≥ 0.8 or ordered-Jaccard ≥ 0.6, reusing the
 * relay's similarity helpers). With no turnText or no match above threshold,
 * fall back to the newest-mtime transcript that has assistant text. Returns null
 * when none of the candidates have assistant text.
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
			const containment = computeContainment(candidate.text, turn);
			const jaccard = computeOrderedJaccard(candidate.text, turn);
			const matches = containment >= 0.8 || jaccard >= 0.6;
			const score = Math.max(containment, jaccard);
			if (matches && score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		if (best) return best;
	}

	// Newest-mtime fallback (candidates preserve refs' newest-first order).
	return candidates[0] ?? null;
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
	settleAttempts?: number;
	settleBackoffMs?: number;
	selectLimit?: number;
}

/**
 * Quiescence-handback capture for a mounted Cursor session. Returns the same
 * CaptureHandbackResult shape the relay consumes for every provider, so nothing
 * in the relay/idle/retry logic changes.
 *
 *  - new assistant text   → { captured, text }              (marker advanced)
 *  - duplicate / no prose → { captured, text: null }        (relay no-response)
 *  - no transcript at all → { degraded_pty_only, text: null } (relay PTY fallback)
 *
 * A bounded settle poll covers a transcript that flushes a beat after quiescence.
 * Never throws into the relay.
 */
export async function captureCursorHandback(
	input: CaptureCursorHandbackInput,
): Promise<CaptureHandbackResult> {
	const listTranscripts = input.listTranscripts ?? (() => listCursorTranscripts());
	const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const attempts = input.settleAttempts ?? 3;
	const backoffMs = input.settleBackoffMs ?? 300;
	const limit = input.selectLimit ?? 5;

	let sawTranscript = false;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (attempt > 0) await sleep(backoffMs);

		let refs: TranscriptRef[];
		try {
			refs = listTranscripts();
		} catch {
			refs = [];
		}
		if (refs.length === 0) continue;
		sawTranscript = true;

		let selected: { path: string; text: string } | null;
		try {
			selected = selectTranscript({ refs, turnText: input.turnText, readFile, limit });
		} catch {
			selected = null;
		}
		if (!selected || selected.text.length === 0) continue;

		const hash = sha256(selected.text);
		if (hash === input.lastDelivered.hash) {
			// Same text as the last handback — the turn added no new prose (e.g. a
			// re-poll, or tool-only work). Don't re-deliver; let the budget expire and
			// report no-response.
			continue;
		}
		input.lastDelivered.hash = hash;
		return { status: "captured", text: selected.text, interferenceDetected: false };
	}

	if (sawTranscript) {
		// A transcript exists but produced no NEW assistant prose this turn →
		// no-response. The relay applies its no_response_captured handling rather
		// than re-delivering a stale turn.
		return { status: "captured", text: null, interferenceDetected: false };
	}
	// Never found a transcript (not flushed / unreadable). Degrade to the PTY
	// scrape so a transcript hiccup never stalls the run.
	return { status: "degraded_pty_only", text: null, interferenceDetected: false };
}
