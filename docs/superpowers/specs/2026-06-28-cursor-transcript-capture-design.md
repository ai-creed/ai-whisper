# Cursor Mounted Handback Capture via Transcript Read — Design

**Date:** 2026-06-28
**Status:** Approved for planning
**Component:** `packages/cli` mounted relay capture path (`mount-session-main.ts` +
new `cursor-transcript-capture.ts`)
**Depends on:** the cursor adapter (PRs 1–3 on `feat/adapter-cursor`)

## Goal

Make the **mounted/interactive** Cursor experience work end-to-end. After PRs 1–3
the one-shot/companion provider path is proven against the real `agent` CLI, but
the mounted handback path is broken for Cursor: the relay captures each turn's
deliverable by injecting `/copy` and reading the system clipboard, and Cursor's
`/copy` is an **interactive picker** (the operator must arrow-select which block
to copy) rather than an immediate "copy last assistant message" like Claude/Codex.
So the relay's automated capture never lands and a mounted Cursor turn stalls.

This phase gives Cursor its own quiescence-handback capture that reads Cursor's
on-disk **session transcript** instead of touching the clipboard.

## Background

### How mounted capture works today

- The mounted relay (`mounted-turn-owned-relay.ts`) detects the implementer going
  quiescent and calls the `captureHandbackText(turnText)` callback wired in
  `mount-session-main.ts:548`.
- For claude/codex that callback runs `captureHandbackText` (the leased clipboard
  capture in `capture-handback-text.ts`): acquire a host-global capture lease,
  snapshot `NSPasteboard.changeCount`, inject `/copy` into the agent PTY
  (`submitInjectedInput("/copy")`), read the clipboard, and validate ownership via
  the changeCount signature. There is already a `confirmPicker` hook that sends
  Enter for *Claude's* simple content-type picker.
- The callback returns a `CaptureHandbackResult`
  (`{ status, text, interferenceDetected }`); the relay's retry ladder, idle
  detection, and auto-handback logic consume that shape. `status` is one of
  `captured | degraded_pty_only | timed_out | lease_unavailable`.
- Cursor currently has `eventPathEnabled = false` and no `onTurnFinished`, so it
  takes this quiescence→clipboard path — which fails because of the picker.

### Why the clipboard path can't be made to work for Cursor

Verified on the real CLI (`agent` v2026.06.26-7079533): `/copy` opens a selection
UI listing the user query and the assistant answer; the operator must choose the
answer block, then it is copied. Enter-on-default (the existing `confirmPicker`)
is not reliable — the default block is not guaranteed to be the assistant's final
answer, and driving the picker with synthesized arrow keys is brittle and
version-coupled. Rejected.

### Why a transcript read works

Verified on disk: in interactive mode Cursor appends, per turn, to a session
transcript JSONL at
`~/.cursor/projects/<project>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl`.
Each line is one JSON object:

```json
{"role":"user","message":{"content":[{"type":"text","text":"<user_query>…"}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"…assistant reply…"}]}}
```

Assistant entries may also carry tool-call content; turns may produce several
assistant text blocks interleaved with tool calls. The file is flushed promptly
(observed updating live during a session). The last assistant text after the last
user entry is the turn's deliverable — exactly the handback text.

### Transcript-selection gotcha (drives the design)

The `<project>` directory name is **not** a reversible transform of the cwd:

- Simple paths map directly: `/Users/me/proj` → `Users-me-proj`.
- Leading dots are stripped: `…/.claude/worktrees/x` → `…-claude-worktrees-x`.
- **Long paths are truncated and hashed**: e.g.
  `…-ai-whisper-clau-643f27c` (truncated stem + 7-char hash suffix).

So deriving the project dir from cwd is unreliable. Selection must not depend on
reconstructing the slug.

## Non-goals

- **Turn-events / push hooks for Cursor.** Cursor's CLI has no firing per-turn
  hook (established in the adapter spec). This phase stays on the
  quiescence-triggered capture, just with a transcript source.
- **Changing the relay state machine.** The relay, idle detection, retry ladder,
  and `CaptureHandbackResult` contract are unchanged; only the capture
  implementation for `target === "cursor"` is new.
- **Reusing the clipboard lease / changeCount for cursor.** The transcript read
  touches no shared global resource, so no lease and no changeCount.
- **The one-shot/companion path.** Already working; untouched.

## Architecture

### New module: `packages/cli/src/runtime/cursor-transcript-capture.ts`

Small, file-IO-injectable functions so unit tests run against fixtures with no
real `~/.cursor`:

- `extractLastAssistantText(jsonl: string): string` — parse JSONL; from the end,
  collect `role:"assistant"` `message.content[]` entries with `type==="text"`
  that occur **after the last `role:"user"` line**, in document order, joined with
  `\n`. (User pick: join all assistant text blocks of the turn, not just the
  last.) Tool-call-only turns yield `""`.
- `listCursorTranscripts(opts): TranscriptRef[]` — glob
  `<home>/.cursor/projects/*/agent-transcripts/*/*.jsonl`, return refs with
  `path` + `mtimeMs`, sorted newest-first. `home` and a `readdir`/`stat` seam are
  injectable.
- `selectTranscript(refs, turnText, readFile): { path; text } | null` — take the
  newest K (default 5) refs; for each, `extractLastAssistantText`; pick the ref
  whose text best matches `turnText` via the existing
  `computeContainment`/`computeOrderedJaccard` (imported from
  `mounted-turn-owned-relay.ts`, as `capture-handback-text.ts` already does) above
  a threshold (containment ≥ 0.8 or ordered-Jaccard ≥ 0.6). If `turnText` is
  empty or nothing clears the threshold, fall back to the single newest-mtime
  ref's text.
- `captureCursorHandback(input): CaptureHandbackResult` — orchestrator:
  1. `listCursorTranscripts`; if none, return
     `{ status: "degraded_pty_only", text: null, interferenceDetected: false }`
     (user pick: a transcript hiccup never stalls — relay hands back the PTY
     scrape).
  2. `selectTranscript`; if null/empty text → `degraded_pty_only`.
  3. **Freshness guard:** hash the selected text; if it equals the caller-held
     `lastDeliveredHash` (turn produced no new assistant prose — e.g. tool-calls
     only, or a re-poll of the same turn), return
     `{ status: "captured", text: null, interferenceDetected: false }` so the
     relay applies its existing no-response handling instead of re-delivering the
     prior turn. Otherwise update the marker and return
     `{ status: "captured", text, interferenceDetected: false }`.
  4. **Settle:** a bounded poll (default up to ~1s, a few attempts) re-reading the
     newest transcript if the first read yields empty/duplicate, in case the file
     flushes a beat after quiescence.

`CaptureHandbackResult` and the similarity helpers are reused, not redefined.

### Wiring: `mount-session-main.ts`

Branch the existing `captureHandbackText` callback once on `input.target`:

- `target === "cursor"` → `captureCursorHandback({ cwd: input.workspaceRoot, turnText, lastDeliveredHash, /* injected fs seams default to real */ })`. No DB/lease open for cursor.
- otherwise → today's leased clipboard capture (unchanged).

A per-mount `{ hash: string | null }` holder (alongside the existing
`copySignature` holder) carries `lastDeliveredHash` across captures.

### Data flow (cursor mounted turn)

1. Implementer (Cursor) finishes; relay detects quiescence; calls
   `captureHandbackText(turnText)`.
2. `captureCursorHandback` lists transcripts, selects the one matching `turnText`,
   extracts the joined assistant text after the last user entry.
3. Freshness guard dedupes against the last delivered handback.
4. Returns `{ status: "captured", text }`; the relay composes the handback and
   passes the baton — identical to every other provider downstream.

## Error handling

- **No transcripts / unreadable dir** → `degraded_pty_only` (PTY scrape handback).
- **Selected text empty (tool-call-only turn)** → after the settle poll,
  `captured` with `text: null` → relay's no-response path.
- **Duplicate of last handback** → `captured` with `text: null` (freshness guard).
- **Malformed JSONL line** → skipped; parsing is best-effort per line.
- **`turnText` empty/unreliable** → newest-mtime fallback selection.
- Capture must never throw into the relay; unexpected errors resolve to
  `degraded_pty_only`.

## Testing

Unit tests (`test/cursor-transcript-capture.test.ts`) with inline JSONL fixtures
and injected fs seams — no real `~/.cursor`, no real `agent`:

- `extractLastAssistantText`: last-assistant-after-last-user; multi-text-block
  join; tool-call-only turn → `""`; assistant text before a later user entry is
  excluded; malformed line skipped; empty input → `""`.
- `selectTranscript`: picks the turnText-matching transcript over a newer-but-
  unrelated one; newest-mtime fallback when turnText empty; fallback when no ref
  clears the threshold.
- `captureCursorHandback`: happy path → `captured` + text; no transcripts →
  `degraded_pty_only`; empty selected text → `degraded_pty_only`/no-response;
  freshness dedup → `captured` text null and marker unchanged; settle-poll
  recovers a late flush.
- Regression: existing mount/relay/turn-events suites stay green (the clipboard
  path for claude/codex is untouched).

A real two-agent mounted run (cursor + claude) remains a manual e2e — out of
scope for automated tests, validated separately on the broker machine.

## Touch list

1. `packages/cli/src/runtime/cursor-transcript-capture.ts` — new module (+ unit
   test).
2. `packages/cli/src/runtime/mount-session-main.ts` — branch `captureHandbackText`
   on `target === "cursor"`; add the per-mount `lastDeliveredHash` holder.
3. `test/cursor-transcript-capture.test.ts` — new.

## Open question (deferred, not blocking)

If Cursor later ships a firing per-turn hook (a real `stop`/`afterAgentResponse`
in CLI mode), the push-based turn-event path could replace this quiescence read
(promotion described in the adapter spec). Until then the transcript read is the
capture mechanism for mounted Cursor.
