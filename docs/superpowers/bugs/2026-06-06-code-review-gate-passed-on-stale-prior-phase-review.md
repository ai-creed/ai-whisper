# Bug: SDD code-review gate passed on a stale prior-phase review; the reviewer's real findings were never delivered and the workflow completed on a gate that never saw the code

**Filed:** 2026-06-06
**Reported by:** operator (post-run database inspection + live observation of the reviewer session)
**Observed on version:** ai-whisper 0.5.1 (the orchestrator install driving the run)
**Observed run:** `wf_433d667d66664446` (spec-driven-development), `code-review` phase (phase index 3), chain `relay_ch_3b18e926f68a4e97`, completed `2026-06-06T10:11:09Z`.

## Symptom

In a `spec-driven-development` run, the final `code-review` phase recorded `evaluator_verdict = approve` (confidence 0.95) and the workflow finished `status = done` — but the reviewer handback that was evaluated **was not a review of the executed code**. It is a byte-for-byte duplicate of the reviewer's handback from the *earlier* `plan-writing` phase: a review of the **plan document** ("Plan extracts…", "Plan lines 24-38", "the implementation plan now covers the spec's acceptance criteria"), not of the code delivered in the `plan-execution` phase.

Live observation of the reviewer session (codex) during the run: the reviewer **did** perform a genuine code review of the executed code, **had findings**, and even issued a `/copy` to surface them. Those findings were **never delivered** to the implementer — by the time the reviewer's real review existed, the phase had already resolved on the stale "approve", the chain was marked `done`, and the workflow completed.

Net effect: the executed code (commits `918ec23..c51c190`) **passed the code-review gate without that gate ever evaluating the code**, and the reviewer's actual findings were silently dropped.

## Expected vs actual

**Expected:** the `code-review` gate evaluates the reviewer's review *of the code produced in `plan-execution`*. If the reviewer reports findings, they are delivered back to the implementer and the phase loops (within its round budget) until the reviewer approves the actual deliverable. The gate passes only on a fresh review of the real code.

**Actual:** the gate captured and accepted a **stale handback** — the reviewer's prior-phase plan review — marked the capture `ok`, the evaluator approved it, the chain/phase/workflow all closed `done`, and the reviewer's genuine code-review findings were never captured or delivered.

## Reproduction

### A. Inspect the recorded occurrence (deterministic — follow blindly)

The failure is preserved in the shared broker DB (`~/.ai-whisper/state.db`). Each step below is an observation, not an inference.

1. The `code-review` handback is identical to the `plan-writing` review handback, and both differ from the implementer's actual `plan-execution` delivery:

   ```bash
   DB=~/.ai-whisper/state.db
   # code-review reviewer handback
   sqlite3 "$DB" "SELECT handback_text FROM relay_handoff WHERE handoff_id='ho_bcab594808754efb';" | shasum
   # plan-writing reviewer handback (earlier phase)
   sqlite3 "$DB" "SELECT handback_text FROM relay_handoff WHERE handoff_id='ho_252f469709204eaf';" | shasum
   # -> both: 9ac416a3a6d440bde4823f6a522f639e3cc9de95  (IDENTICAL)
   # plan-execution implementer handback (the real delivered code)
   sqlite3 "$DB" "SELECT handback_text FROM relay_handoff WHERE handoff_id='ho_f245ae078169489a';" | shasum
   # -> 79576f36cee9...  (different — this is what code-review should have been reviewing)
   ```

2. The `code-review` request was correct (it asked for a review of the commits), so the stale content did not come from a bad request:

   ```bash
   sqlite3 "$DB" "SELECT substr(request_text,1,200) FROM relay_handoff WHERE handoff_id='ho_bcab594808754efb';"
   # -> "Review the implementer's changes for this phase — the commits in 918ec23..HEAD ... run the project's verification/tests."
   ```

3. The capture for that handoff was recorded as a clean success while the clipboard and the live PTY turn disagreed completely:

   ```bash
   sqlite3 -line "$DB" "SELECT capture_status, clip_len, turn_len, turn_confidence,
     jaccard_score, containment_score, interference_detected, aborted_by_race_guard,
     substr(clip_sample,1,80) AS clip_sample, substr(turn_sample,1,80) AS turn_sample
     FROM relay_capture_diagnostics WHERE handoff_id='ho_bcab594808754efb';"
   # capture_status=ok | clip_len=3732 (clip_sample = the stale "Review matrix … Plan extracts…")
   # turn_len=68853   (turn_sample = the freshly-injected review prompt, a different thing)
   # turn_confidence=high | jaccard_score=NULL | containment_score=NULL
   # interference_detected=0 | aborted_by_race_guard=0
   ```

4. The stale handback drove the verdict and the workflow then completed:

   ```bash
   sqlite3 -line "$DB" "SELECT status, evaluator_verdict, evaluator_confidence,
     orchestrator_verdict, created_at, resolved_at, orchestrator_evaluated_at
     FROM relay_handoff WHERE handoff_id='ho_bcab594808754efb';"
   # status=handed_back | evaluator_verdict=approve | confidence=0.95 | orchestrator_verdict=done
   sqlite3 -line "$DB" "SELECT status, current_phase_index, updated_at FROM workflows WHERE workflow_id='wf_433d667d66664446';"
   # status=done | current_phase_index=3
   ```

### B. Conditions that produced it (to construct a live or test reproduction)

The run that triggered this had the shape:

- An SDD run on macOS (clipboard `/copy` capture path), reviewer = codex, implementer = claude.
- The reviewer's **last copyable turn before the `code-review` phase was its `plan-writing` review** — across the intervening `plan-execution` phase the reviewer produced no new copyable turn of its own.
- When the `code-review` phase opened and the reviewer's handback was captured, the captured clipboard content was the reviewer's *prior-phase* review rather than a fresh review of the executed code, yet it was accepted (`capture_status=ok`) and resolved the gate before the reviewer's real, findings-bearing review of the code completed.

A reproduction is confirmed when a captured reviewer handback that is accepted as a phase gate's input is content from a previous phase / a previous copyable turn (i.e. not produced in response to the current phase's request), and/or when a reviewer that actually produces findings has those findings dropped because the gate resolved on earlier content.

## Acceptance for "fixed"

- A phase gate must not pass on a captured handback that was not produced in response to that phase's request (no stale / prior-phase / prior-turn content silently accepted as the current handback).
- When the reviewer produces findings for the current phase, those findings reach the implementer and the phase loops rather than completing — i.e. the `code-review` gate cannot report `done` on a deliverable the reviewer did not actually approve.
- A regression test reproduces the stale-capture-passes-gate condition and is GREEN after the fix.

## Hunch (unverified — for the diagnosis phase to confirm or discard, not a settled cause)

The capture appears to have read the reviewer's clipboard while it still held the prior phase's `/copy` content (the freshness/agreement scores `jaccard`/`containment` are NULL on this row, and `clip` vs `turn` diverged completely while `capture_status` was still `ok`). Whether the trigger is a premature idle auto-handback firing before the reviewer's fresh review/`/copy` landed, an accept path that does not validate the clip against the current turn/request, or a phase-close race that drops a late genuine handback — is for the investigation to determine.

## Non-goals / notes

- Do not treat the hunch above as the root cause; reproduce and prove it.
- The implementer's `plan-execution` delivery itself (commits `918ec23..c51c190`, branch `feat/ezio-surface-extraction`) is out of scope for this bug — this report is about the review gate accepting stale content, independent of whether that code is good.
- Related prior capture-path bugs (different modes) for context only: `docs/superpowers/bugs/2026-05-29-handback-capture-failures.md`, `docs/superpowers/bugs/2026-06-03-auto-handback-empty-capture-permanent-halt.md`.
