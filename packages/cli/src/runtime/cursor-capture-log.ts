import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Cursor capture breadcrumbs.
//
// Persistent, append-only JSONL trail of each mounted-Cursor capture decision so
// selection can be debugged after the fact: how many transcripts were considered
// (post-freshness), how many matched the delivered prompt, which one was chosen,
// the captured text length, and the resolved status. Best-effort — a logging
// failure must never disturb the relay.
// ---------------------------------------------------------------------------

export interface AppendCursorCaptureLogSeams {
	home?: string;
	now?: () => string;
	/** Ensure a directory exists (recursive). */
	mkdir?: (dir: string) => void;
	/** Append a chunk to a file. */
	append?: (path: string, data: string) => void;
}

/** The on-disk breadcrumb path for a given home directory. */
export function cursorCaptureLogPath(home: string): string {
	return join(home, ".ai-whisper", "logs", "cursor-capture.jsonl");
}

/**
 * Append one capture breadcrumb as a JSONL line (timestamp + the given record).
 * Creates the logs directory if needed. Swallows all errors — the relay must not
 * be affected by an unwritable log.
 */
export function appendCursorCaptureLog(
	record: Record<string, unknown>,
	seams: AppendCursorCaptureLogSeams = {},
): void {
	const home = seams.home ?? homedir();
	const now = seams.now ?? (() => new Date().toISOString());
	const mkdir = seams.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
	const append =
		seams.append ?? ((path: string, data: string) => appendFileSync(path, data));

	try {
		const path = cursorCaptureLogPath(home);
		mkdir(join(home, ".ai-whisper", "logs"));
		append(path, `${JSON.stringify({ ts: now(), ...record })}\n`);
	} catch {
		// best-effort — never disturb the relay
	}
}
