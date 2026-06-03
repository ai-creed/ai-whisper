# Bug: long claude steps halt with "No handbackText provided" — a single empty auto-handback capture is terminal (one-shot, no retry)

**Filed:** 2026-06-03
**Halted workflow:** `wf_1d415f8b674c4f2b` (spec-driven-development), `current_phase_index=2`, halted `2026-06-03T09:46:50Z`.
**Affected version:** 0.4.3 (the database-is-locked fix from 0.4.2 is present and is NOT this bug).
**Affected components:**
- `packages/cli/src/runtime/mounted-turn-owned-relay.ts` (`checkIdleActions` auto-handback driver — root cause)
- `packages/cli/src/runtime/mount-session-main.ts` (1s idle poll, 30s idle threshold)
- `packages/cli/src/runtime/clipboard-handback-capture.ts` (`/copy` clipboard-change poll)
- `packages/broker/src/control/workflow-control.ts` (empty handback → escalate → halt, no retry)

## Symptom

Autonomous workflow halts with:

> No handbackText provided; executor did not respond or report any work completion. Cannot verify plan execution, verification command results, or commit SHAs.

This is a **third, distinct mode** from the two in `2026-05-29-handback-capture-failures.md`:
- Mode A (claude short reply): `clip_len ∈ (0,100)`, `turn_len=0`, `no_response_captured_confidently` — clip is **non-empty**.
- Mode B (codex prompt-never-submitted): `clip_len=0`, `turn_len≈150k`, codex target.
- **Mode C (this bug):** claude target, `clip_len=0` **and** `turn_len=0`, `no_response_captured`.

## Evidence (`~/.ai-whisper/state.db`)

Failing handoff `ho_9b83887d3a7c4210` (codex→claude, step `execute`):
`capture_status=no_response_captured, clip_len=0, turn_len=0, turn_confidence=low, aborted_by_race_guard=0, interference_detected=0`. Handoff ran **778s (~13 min)** before resolving empty.

Every `clip=0, turn=0, no_response_captured` row in history is **claude** on a **long heavy step** (execute/fix):

| date | step | clip | turn | dur_s |
|---|---|---|---|---|
| 2026-06-03 | execute | 0 | 0 | 778 |
| 2026-05-30 | fix | 0 | 0 | 53 |
| 2026-05-28 | fix | 0 | 0 | 1702 |
| 2026-05-28 | execute | 0 | 0 | 2534 |

`turn_len=0` is **expected** for claude: full-screen TUI output → `normalizeCapturedOutput` (assistant-turn-capture.ts) strips CSI + bare-`\r` overwrite to empty. The clipboard `/copy` is claude's intended capture path. So the real fault is **`clip_len=0`: `/copy` produced no clipboard change** that one time.

### It is intermittent, not size-deterministic

Successful claude execute steps run **longer** than the failures (e.g. 2749s, 2567s ok vs 2534s fail). So duration does not *cause* the failure — it raises *exposure*. Captures are binary: success lands 1000–4066 chars; failure lands exactly 0. That is a discrete transient empty capture, not a partial/truncated one.

## Root cause

`checkIdleActions` (mounted-turn-owned-relay.ts:594-736) fires the auto-handback **exactly once per handoff**: the `autoHandbackFiredFor = accepted.handoffId` guard is set **before** the capture result is known. It is gated only by the 30s output-silence heuristic (`mount-session-main.ts:452`, `idleThresholdMs` default 30s, 1s poll). Unlike the manual `[h]` path (`getAcceptedReadyHandoff` → `hasVisibleAssistantTurn()` + 30s readiness), the auto path has **no readiness gate and no retry**.

Consequence: any single empty capture is **terminal**.
1. `checkIdleActions` fires once; capture returns `clip=0/turn=0` (a transient — either the idle threshold tripped during a silent sub-window of a long step before a copyable turn existed, or a one-off `/copy`-picker miss).
2. `classifyCapture` → `no_response_captured`; `requestText=""`.
3. `handoffBackRelay` delivers an empty handback; the orchestrator evaluator returns `escalate`.
4. `escalate`/`execution-fail` for `execute`/`fix` halts immediately (`workflow-control.ts:1004-1023`) — **no retry**.
5. The one-shot guard means claude's real completion (10+ min later) is never re-captured.

The longer the step, the more idle sub-windows / `/copy` attempts, the higher the chance one transient empty capture occurs — and one is enough to halt permanently.

## Residual uncertainty

DB evidence pins the root-cause **class** and the terminal-ness with high confidence. It does **not** distinguish the exact transient that produces the empty capture:
- (a) **premature idle fire** — the 30s silence tripped during a quiet sub-window while claude was still working, before any copyable assistant turn existed; or
- (b) **`/copy` picker miss** — claude was genuinely idle/done but the `/copy` trigger/picker did not register a clipboard change within the ~1.1s poll window that one time.

Confirming which requires runtime instrumentation (`AI_WHISPER_DEBUG_CAPTURE`, `AI_WHISPER_DEBUG_INPUT_LOG`, and the existing `console.warn` traces in `checkIdleActions`) on a reproducing mounted run. None were enabled/persisted for the halted run.

## Fix (robust to either transient)

Make the auto-handback **non-terminal on an empty capture**, at the capture layer (upstream of the orchestrator — the doc non-goal "do not change the orchestrator's halt-on-empty-handback policy" still holds).

In `checkIdleActions`, replace the unconditional one-shot guard with bounded retry-on-empty:

- Track per-handoff `{ attempts, nextEligibleAt }` instead of a single fired flag.
- On entry, skip if `now < nextEligibleAt` (spacing — the 1s poll must not hammer `/copy` every second).
- Run the capture. If the handback is **deliverable** (`ok`, or a degrade with PTY text) → hand back, mark the handoff terminal (`autoHandbackFiredFor`).
- If **`captureStatus === "no_response_captured"`** (captured *nothing* — no clipboard, no PTY fallback) and `attempts+1 < MAX` → increment `attempts`, set `nextEligibleAt = now + RETRY_MS`, `console.warn`, and **return without handing back** (do not burn the guard).
- Retry is **scoped to `no_response_captured` only**. `no_response_captured_confidently` means the agent *did* reply (non-empty clipboard) but it failed the similarity gate — re-running `/copy` would re-capture the same reply, so it is delivered immediately (that is Mode A, a separate classifier concern, not a transient).
- If `no_response_captured` and retries exhausted → record the diagnostic and hand back empty (current escalate→halt behavior preserved as the genuine-failure floor).

Why this fixes **both** transients:
- Premature fire: the empty attempt schedules a retry; claude resumes output (resets `lastActivityAt`), goes idle again only when actually done, and the next attempt's `/copy` reads claude's real transcript. (`/copy` copies claude's actual last message, independent of our PTY turn buffer, so a cleared `current` does not lose the real answer.)
- `/copy` miss: claude stays idle; the next attempt after `RETRY_MS` re-issues `/copy`, which lands.

**No readiness-gate change.** `hasVisibleAssistantTurn()` is unsafe here: `checkIdleActions` calls `finishAssistantTurn()` (which clears `current` and may set `latestCompleted=null`), so a gate on it would block all retries once `current` is empty. Retry-on-empty alone is sufficient.

**Concurrency reservation (required).** The old code set the one-shot guard *before* the awaited capture, which incidentally serialized the mount's 1s-timer ticks. The retry ladder records its state only *after* the await (which can take ~1.3s clipboard poll + up to 4s lease wait), so a later tick could pass the spacing check and start an overlapping `/copy` for the same handoff — and even double-deliver on success. The fix adds a synchronous `autoHandbackInFlight` flag set before the await and cleared in a `try/finally` on every exit (retry return, race-guard abort, delivery, or throw); a leaked reservation would wedge auto-handback for the whole session, so the `finally` is mandatory. (Alternative, not taken: gate the mount timer against concurrent `checkIdleActions()` — the relay-level reservation is unit-testable and local to the state it protects.)

Defaults (env-overridable): `MAX≈3`, `RETRY_MS≈10000`. Worst case adds ~`(MAX-1)·RETRY_MS` before a genuine empty escalates.

## Tests

- `checkIdleActions`: first call with an empty capture does **not** call `handoffBackRelay` and does **not** set the terminal guard; a subsequent call returning non-empty **does** hand back the captured text. (RETRY_MS=0 in test to bypass spacing.)
- Exhaustion: MAX consecutive empty captures → after the MAX-th, `handoffBackRelay` is called once with empty `requestText` and `captureStatus=no_response_captured` (escalate floor preserved).
- Spacing: with RETRY_MS>0, a second call before `nextEligibleAt` is a no-op (no capture attempt, no handback).

## Non-goals

- Do not change the orchestrator's halt-on-empty-handback policy. Genuine empty handbacks must still escalate after retries are exhausted.
- Do not change the 30s idle threshold or the lease TTL/acquire defaults.
- Codex Mode B (prompt-never-submitted) is a separate, already-shipped fix (bracketed paste, 0.4.3).
