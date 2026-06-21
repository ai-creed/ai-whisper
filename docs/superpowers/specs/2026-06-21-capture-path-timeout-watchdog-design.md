# Capture-path timeout + watchdog — preventing silent workflow hang on clipboard/pasteboard wedge

**Date:** 2026-06-21
**Status:** Revised after spec-review round 3 (reconciles every `releaseCaptureLease` call site with the token-scoped contract — per-capture release is token-scoped, mount teardown release is pid-scoped — so no bare collab-only release remains)
**Area:** `packages/cli/src/runtime` — auto-handback capture pipeline

## Problem

When the host machine sleeps, locks, fast-user-switches, or hits an auto-logout
transition, the macOS pasteboard server (`pboard`) can become unreachable or
unresponsive while the ai-whisper mount processes are still alive. The
auto-handback clipboard capture (the "triple copy attempt") then makes blocking
calls to `pbpaste` and the NSPasteboard `changeCount` helper that never return.
The workflow hangs: the captured handback is never written to the broker, so the
relay orchestrator never sees anything to evaluate, and the workflow stalls
indefinitely with no diagnostic.

### Scope (which capture path this affects)

As of 2026-06-14 the push turn-completion **event path is the default** capture
methodology for claude and codex; the clipboard `/copy` path is **retained as
the automatic fallback** (used for indeterminate / no-event / fidelity-exhaustion
cases, and as the full path whenever the event path is killed via
`AI_WHISPER_TURN_EVENTS=off`/`none` or a provider subset). The hang therefore
strikes the `/copy` fallback firings and kill-switched configs rather than the
default event path. The fix below targets the clipboard capture path regardless
of how often it is reached.

### Root cause

Two compounding defects:

1. **Unbounded I/O.** The capture pipeline shells out via `execFile` with no
   `timeout`:
   - `pbpaste` read — `packages/cli/src/runtime/clipboard-handback-capture.ts`
     (the `execFile` call used by `captureClipboardHandback`).
   - NSPasteboard `changeCount` helper —
     `packages/cli/src/runtime/clipboard-change-count.ts` (the `execFile` call
     used by `makeChangeCountReader`).

   Node's `execFile` defaults to no timeout, so if the child blocks on an
   unresponsive `pboard`, the promise never settles. The `try/catch` in
   `makeChangeCountReader` only catches *rejections*, not a child that never
   exits.

2. **A latch that never releases.** The relay's auto-handback path
   (`packages/cli/src/runtime/mounted-turn-owned-relay.ts`) sets
   `autoHandbackInFlight = true` *before* awaiting the capture
   (`await input.captureHandbackText?.(...)`) and clears it only in a `finally`.
   If that await never settles, the `finally` never runs, and every subsequent
   idle tick early-returns at the `if (autoHandbackInFlight) return` guard. The
   mount never attempts capture again — a permanent, silent wedge. (The Mode-C
   concurrency-guard work already warned that "a leaked reservation wedges
   auto-handback for the whole session"; an unsettled await is exactly such a
   leak.)

A capture that *throws* is handled only in the narrow sense that the relay wraps
the await in `try/catch` and maps a throw to `clipboardText = null` — but that
mapping is **not sufficient for a timeout**. A null clip paired with non-empty
PTY chrome classifies as `no_response_captured_confidently` (the no-retry bucket)
and delivers an empty handback rather than retrying — the Mode D shape. So a
timeout must be a *distinct, retryable* signal, not a generic throw (this is the
Blocking-1 finding from review; see L1/L3). The other unhandled failure mode is a
promise that **never settles**, which no catch can reach at all.

### Confirmed instance

This is an observed hang, not only a theoretical one. Workflow
`wf_02559587f623419f` (spec-driven-development, collab
`collab_20260614143614352_7557ac83`) wedged on handoff `ho_8d928f327e06462`
(ezio→claude, i.e. claude's turn to produce the handback):

- Accepted 16:01:39; last PTY output 16:06:40 (claude streamed for ~5 min, then
  the machine went quiet); then **no handback for ~84 minutes** until the
  operator canceled at 17:30. The row stayed `handback_text` NULL,
  `capture_status` NULL, orchestrator `idle` — precisely "nothing delivered to
  the relay orchestrator."
- **No `relay_capture_diagnostics` row and no `relay_turn_event_diagnostics` row**
  for the stuck handoff. In fact the whole collab logged **0 turn-event
  diagnostics**, so claude's handbacks rode the `/copy` fallback throughout —
  "turn-events supported" did not mean turn-events were delivering.
- The diagnostic write proves where it stalled: `recordCaptureDiagnostic`
  (`mounted-turn-owned-relay.ts`) runs **strictly after** the capture await. The
  retry-on-empty ladder also skips the row, but that ladder exhausts in ~30s
  (`MAX_ATTEMPTS` 3 × `RETRY_MS` 10s) and cannot account for an 84-minute gap.
  The only remaining explanation is that the capture await never returned — so
  `autoHandbackInFlight`, set before the await and cleared only in `finally`,
  never released, and every later idle tick short-circuited at
  `if (autoHandbackInFlight) return`. A permanent silent wedge, matching the
  failure mode above exactly.

## Goals

- A wedged `pbpaste`/`changeCount` call can never block the capture pipeline
  indefinitely.
- The `autoHandbackInFlight` latch is always released, regardless of *where* in
  the capture path a hang originates.
- On a capture timeout, the workflow makes forward progress through the existing
  retry ladder, which self-heals when the machine wakes, and only escalates at
  the established budget-exhaustion floor.
- Timeout thresholds are configurable via environment variables.

## Non-goals

- Making the clipboard capture *succeed* while `pboard` is down. We convert an
  infinite silent hang into a bounded, visible, self-healing degrade — we do not
  recover unreadable clipboard contents.
- Preventing the machine from sleeping/locking. `caffeinate` is a complementary,
  separately-tracked mitigation that reduces how often `pboard` goes down; it is
  out of scope for this spec.
- Fixing *when* the `/copy` fallback fires. The sleep-fooled idle detector
  (below) is a distinct, separately-tracked defect; this spec only stops a fired
  capture from hanging, not the premature firing itself.

## Out of scope: the sleep-fooled idle detector (a separate defect)

This spec fixes the *hang* — once the `/copy` fallback fires into a wedged
`pboard`, the capture can no longer block forever. It deliberately does **not**
address a distinct, adjacent defect in *when* the fallback fires.

The mount's idle detector is wall-clock based. `checkIdleActions` runs when
`Date.now() - lastActivityAt >= idleThresholdMs` (default 30s,
`mount-session-main.ts`), and the no-event safety net releases `/copy` when
`idleElapsedMs >= TURN_EVENT_NO_EVENT_GRACE_MS` (default 8s,
`mounted-turn-owned-relay.ts`). `lastActivityAt` advances only on PTY output
(`onProviderOutput`). A system suspend / lock / fast-user-switch / auto-logout
freezes PTY output and the turn-event socket while wall-clock `Date.now()` keeps
advancing across the suspended interval. On the first timer tick after wake,
`idleElapsedMs` therefore balloons to the full suspend duration and instantly
clears both the idle and the no-event-grace thresholds — firing the `/copy`
fallback as an artifact of the suspend, independent of whether the agent had
actually finished its turn.

Consequence: the fallback can fire on/after the wake boundary even when the
agent was still mid-turn (its turn-completion event simply had not arrived yet,
or was dropped during the freeze). That is a *premature-fire* problem, not a
*hang* problem.

Why it is safe to defer: the L1+L3 fix is cause-agnostic. Whether the post-wake
`/copy` fired correctly (agent done, event lost) or prematurely (agent still
mid-turn), the timeout + watchdog + retry guarantee the latch releases and the
capture re-attempts on later idle ticks. A premature fire therefore degrades to
a bounded retry that self-heals once the agent resumes and produces a clean
turn, rather than a silent hang. Fixing the hang neutralizes the *symptom* of
the premature-fire defect without fixing its *cause*.

A proper fix (out of scope here, tracked separately) would make idle detection
suspend-aware — e.g. detect a large wall-clock jump between consecutive timer
ticks and reset `lastActivityAt` (or skip one idle evaluation) so the grace
window restarts from wake rather than counting the frozen interval. That is a
behavioral change to idle/fallback timing with its own test surface, and is
deliberately not bundled into the timeout/watchdog work.

## Design

Two layers.

### L1 — Bound the clipboard I/O

Add a `timeout` and `killSignal: "SIGTERM"` to both `execFile` calls, threaded
through as an injectable `timeoutMs` so tests stay deterministic.

- `clipboard-handback-capture.ts`: `captureClipboardHandback` gains an optional
  clipboard-timeout input; the default `pbpaste` `readClipboard` closure applies
  it to its `execFile`. (When a custom `readClipboard` is injected — tests — the
  timeout is irrelevant.)
- `clipboard-change-count.ts`: `makeChangeCountReader` gains an optional
  `timeoutMs` in its deps; the default `runHelper` closure applies it to its
  `execFile`.

On timeout, `execFile` sends `SIGTERM` to the child and the callback fires with a
killed error (`err.killed === true`), so the wrapper promise **rejects** within
`timeoutMs`. Crucially, the wrapper does not reject with a *generic* error — it
re-rejects with a **tagged** `CaptureIoTimeoutError` (exported from
`clipboard-handback-capture.ts`) so a timeout stays distinguishable from any other
capture failure all the way up the stack:

- `makeChangeCountReader`'s existing `catch` maps *any* rejection (including the
  tagged timeout) to `null` — a wedged `changeCount` alone must not fail the
  capture (ownership check is simply skipped), and `pbpaste` is the signal that
  matters. No change to that catch.
- `captureClipboardHandback` propagates the tagged rejection unchanged. In
  `captureHandbackText` the `runCapture()` await therefore throws the tagged
  error; `captureHandbackText` recognizes it (`instanceof CaptureIoTimeoutError`)
  and returns a new structured result `{ status: "timed_out", text: null }` — its
  `finally` still releases the lease. Any *non-timeout* throw re-propagates exactly
  as today (→ relay catch → `clipboardText = null`).

Routing the timeout as a typed `timed_out` result — instead of letting it ride
the generic throw→`null` path — is what fixes Blocking-1: in L3 the relay maps
`timed_out` into the **same** `captureTimedOut` retry signal the watchdog uses. A
bare null clip would otherwise land in the no-retry
`no_response_captured_confidently` bucket on non-empty PTY and halt (Mode D).
(`CaptureHandbackStatus` gains a `"timed_out"` member — and a
`"lease_unavailable"` member for the lease-contention case, see *Lease safety
under longer captures* — alongside `captured` / `degraded_pty_only`.)

This kills the literal root cause (no zombie child) and turns the common wedge
into a bounded, *retryable* timeout in roughly one-to-two timeout windows.

### L3 — Guarantee latch release (boundary watchdog) + retry-on-timeout

`captureTimedOut` is the single retry signal for *all* non-deliverable, retryable
capture outcomes (timeout **or** lease contention — the name is historical). It is
raised by **three** sources that feed identical handling:

1. **L1 fast path (typical timeout).** When the relay's branch on the capture
   result sees `status === "timed_out"` (an `execFile` kill that settled within
   `timeoutMs`), it sets `captureTimedOut = true` and leaves `clipboardText` null.
2. **Lease contention.** When the result is `status === "lease_unavailable"` —
   `captureHandbackText` could not acquire the host-global lease within its bounded
   poll (another mount is capturing, or a watchdog-abandoned orphan still holds it)
   — the relay likewise sets `captureTimedOut = true`. It does **not** deliver a PTY
   fallback: lease contention is a transient-busy condition, not a no-response (see
   *Lease safety under longer captures*).
3. **Watchdog backstop.** Wrap the `await input.captureHandbackText?.(...)` in a
   race against a deadline. If the await **never settles** — the case L1 cannot
   reach: a kill that did not terminate the child, or a non-execFile hang such as
   a blocking PTY write in `submitInjectedInput` — the watchdog fires, logs a
   diagnostic warn, discards any (orphaned) result, and sets
   `captureTimedOut = true`.

On any source the relay then:

- **adds `captureTimedOut` to the Mode-C retry condition** so the timeout joins
  the existing retry-on-empty ladder (increment per-handoff `attempts`, set
  `nextEligibleAt = now + RETRY_MS`, return WITHOUT handing back), and
- falls through so the outer `finally` clears `autoHandbackInFlight`.

With defaults the L1 `timed_out` path is the one that almost always fires (the
8s/≈16s exec timeout beats the 20s watchdog); `lease_unavailable` covers a retry
that races a still-held lease; the watchdog exists purely so a hang L1 cannot kill
still releases the latch and retries. All three lead to the identical self-healing
retry, bounded by `MAX_ATTEMPTS` and escalating at the floor.

**Why a flag and not "leave `clipboardText` null".** Leaving the clip null is not
a uniform `no_response → retry`. When PTY turn text is non-empty (high-confidence
chrome), a null clip classifies as `no_response_captured_confidently` with
`jaccardScore = null` — the **no-retry** bucket (reserved for Mode A: agent
replied, present short clip) — and would deliver an empty handback → escalate →
halt. That is the Mode D failure shape. An explicit `captureTimedOut` signal
routes the timeout into the retry ladder regardless of turn text, exactly as
Mode D added `emptyClipConfidentMiss` to that condition.

This guarantees the latch is released for **any** hang in the capture path —
including ones L1 does not cover (e.g. a blocking PTY write in
`submitInjectedInput`, or a future added await) — and turns a timeout into a
self-healing retry rather than a halt. On budget exhaustion the existing
escalate floor delivers (visible failure, not a silent hang).

A watchdog-abandoned orphan (the await never settled, so its `finally` has not run
and it still holds the lease) is handled by the lease reconciliation below: a later
retry that finds the lease still held gets `lease_unavailable` and stays on the
retry ladder rather than delivering PTY; the orphan's eventual late release is
token-scoped so it cannot clobber a newer lease; and the relay has already
discarded the orphan's result. See **Lease safety under longer captures** for the
precise mutual-exclusion guarantee and why the orphan overlap is safe.

The watchdog uses an injectable timer so it can be tested with controlled time.

### Lease safety under longer captures

Raising the capture I/O ceiling to 8000ms per exec (≈16s for both) plus a 20000ms
watchdog collides with the host-global capture lease, whose default TTL is
`DEFAULT_LEASE_TTL_MS = 5000`
(`packages/broker/src/storage/clipboard-capture-lease.ts`). `acquireCaptureLease`
treats a holder as reclaimable once it is *stale*, and `isStale` counts a live
holder stale **purely by age** once `now - acquired_at > ttlMs`. Two
consequences, both raised in review:

1. **Mid-capture reclaim.** `captureHandbackText` holds the lease across the
   `changeCount` and `/copy` awaits — now up to ≈16–20s. After 5s the still-active
   holder looks stale, so a second capture (another collab, or this collab's own
   retry) can acquire concurrently → exactly the overlapping `/copy` race the lease
   exists to prevent.
2. **Orphan release clobber.** `releaseCaptureLease` matches on `holder_collab_id`
   alone. If a timed-out capture A orphans (its `finally` runs late) while a newer
   same-collab capture B has already acquired, A's release clears **B's** lease and
   B then runs unprotected.

Reconciliation — the lease-API changes live in `clipboard-capture-lease.ts`, and
the release-signature change propagates to its two call sites
(`capture-handback-text.ts`, `mount-session-main.ts`):

- **TTL ≥ watchdog.** Raise `DEFAULT_LEASE_TTL_MS` to comfortably exceed the
  watchdog deadline (default `25000` = watchdog 20000 + headroom), and let the
  capture call site override it via the existing `LeaseOptions.ttlMs`, wired from
  the same watchdog env so the two can never drift (TTL is always
  `watchdogMs + margin`). A *settling* capture is then never stale-by-age while in
  flight — it finishes within the watchdog window, comfortably under TTL (the
  non-settling orphan case is handled in *The precise guarantee* below).
  `isPidAlive` still reclaims a truly dead holder immediately, independent of TTL —
  crash recovery is unaffected.
- **Token-scoped release.** `acquireCaptureLease` returns the `acquired_at` it
  wrote — a per-acquisition fencing token (`string | null`, so existing truthy
  acquire checks still work). `releaseCaptureLease(db, collabId, token)` adds
  `AND acquired_at = ?` to its `WHERE`, so it clears only the *exact* lease the
  caller acquired. A late orphan release (token = A's `acquired_at`) no longer
  matches B's row (B's `acquired_at` is strictly later, guaranteed by the
  ≥`RETRY_MS` retry spacing) and is a no-op. `captureHandbackText` captures the
  token on acquire and passes it to its `finally` release. `sweepStaleCaptureLease`
  is unchanged (startup-only, still TTL/pid based). No schema migration — the
  `acquired_at` column already exists and is reused as the token.
- **Both release call sites reconciled (no bare collab-only release remains).**
  There are exactly two source call sites of `releaseCaptureLease`, and the
  signature change must update both atomically (or the build breaks):
  - **Per-capture** (`capture-handback-text.ts`, the capture `finally`):
    token-scoped — `releaseCaptureLease(db, collabId, token)` using the token the
    acquire returned. This is the orphan-clobber guard.
  - **Mount teardown** (`mount-session-main.ts` `stop()`): the existing
    `releaseCaptureLease(db, collabId)` is a *coarse terminal cleanup* with no
    specific token. It becomes **pid-scoped** via a dedicated
    `releaseCaptureLeaseForHolderPid(db, collabId, pid)` that clears
    `WHERE holder_collab_id = ? AND holder_pid = ?` with `pid = process.pid`.
    Pid-scoping is correct here because (a) teardown has no single acquisition
    token to scope to, (b) the per-capture acquire uses `process.pid`, so
    `collab + process.pid` precisely identifies the leases *this* mount holds, and
    (c) it cannot clobber a reconnected same-collab mount running under a
    *different* pid — the very clobber a bare collab-only release would cause. It
    also pre-empts the pid-reuse hazard that `isPidAlive`-based reclaim alone would
    miss (clearing the lease before exit, so no stale row survives for a reused
    pid to keep falsely "alive"). The teardown release stays best-effort; the
    startup sweep / TTL remains the ultimate backstop.
- **Acquire-failure re-typed.** `captureHandbackText`'s bounded-poll lease-acquire
  failure returns the new `lease_unavailable` status (previously
  `degraded_pty_only`). The relay routes `lease_unavailable` into the
  `captureTimedOut` retry ladder; `degraded_pty_only` now means *only*
  interference-exhaustion and keeps its PTY-fallback delivery. This is what keeps a
  timeout/contention retry off the partial-PTY path (the round-2 "no PTY fallback
  on timeout" fix).

**The precise guarantee.** Every capture that *settles* does so within the
watchdog window — healthy captures finish in a few seconds, and even a
double-`execFile`-timeout settles in ≈16s, both under the 20000ms watchdog. With
TTL ≥ watchdog, a settling capture is therefore **never** reclaimed by age while
in flight: that is the host-global mutual exclusion among cooperative captures,
and it holds intact under the longer windows. (The lease holder pid is the mount's
own pid, which stays alive, so `isPidAlive` never reclaims it mid-episode — age is
the only reclaim path, and TTL ≥ watchdog closes it for settling captures.)

A capture that does *not* settle by the watchdog is abandoned by L3 (latch
released, result discarded) and its lease lingers. Once its age crosses TTL a later
retry may reclaim it. This does **not** break the guarantee above (the orphan is
non-cooperative by definition) and is safe on three independent grounds:

1. **Benign overlap.** A reclaim-by-age implies the orphan is *still* wedged — a
   responsive `pboard` would have let its child exit and release the lease within
   moments, so a still-held lease at retry time means `pboard` is still down. The
   retry's fresh `/copy` therefore meets the same wedged `pboard` and simply times
   out too: there is no *successful* concurrent capture, only two harmless pending
   timeouts.
2. **Token-scoped release.** The orphan's late release matches only its own
   `acquired_at`, so it can never clear the retry's newer lease.
3. **Result discard.** The relay throws away the orphan's result, so no stale
   handback is ever delivered.

And the load-bearing point for review: a retry that finds the lease still held does
**not** fall back to PTY — `captureHandbackText` returns `lease_unavailable` and the
relay keeps it on the `captureTimedOut` retry ladder (bounded, escalating at the
floor), never a partial-PTY handback.

This is why TTL stays `watchdog + margin` rather than being inflated to span the
whole retry budget: a budget-spanning TTL would couple it to four knobs
(`watchdog`, `MAX_ATTEMPTS`, `RETRY_MS`, `acquireMaxWaitMs`), block cross-collab
capture for ~minutes, and is unnecessary — the three guards above already make
orphan overlap safe, and the only mutual-exclusion guarantee that *matters*
(cooperative captures never reclaimed mid-flight) needs only TTL ≥ watchdog.

### Wiring

Resolve the I/O-timeout and watchdog env knobs in `mount-session-main.ts` via the
existing `resolvePositiveIntEnv` helper and pass them down:

- the clipboard I/O timeout → `makeChangeCountReader({ timeoutMs })` and the
  `captureClipboardHandback({ ... })` construction,
- the watchdog deadline → the mounted turn relay constructor,
- the lease TTL → `captureHandbackText`'s `leaseOptions: { ttlMs }`, derived as
  `watchdogMs + margin` from the same watchdog env so TTL ≥ watchdog by
  construction.

`captureHandbackText` additionally threads the token returned by
`acquireCaptureLease` through to its `finally` release (token-scoped release,
above) — internal to the capture function, no new env.

The retry budget itself reuses the existing `AI_WHISPER_AUTO_HANDBACK_MAX_ATTEMPTS`
(default 3) / `AI_WHISPER_AUTO_HANDBACK_RETRY_MS` (default 10000) knobs — no new
retry knob.

## Behavior — before / after

**Before:** `pboard` wedges → `execFile` never returns → capture await never
settles → `autoHandbackInFlight` stuck true → mount never re-attempts, nothing
written to broker → orchestrator polls forever → silent infinite hang.

**After:** `pboard` wedges → the `execFile` child is killed and the capture
returns a `timed_out` result within `timeoutMs` (or, for a hang L1 cannot kill,
the watchdog fires at its deadline) → either way `captureTimedOut` is set and the
capture **retries on a later idle tick**. The lease is released token-scoped; a
settling capture (≤ watchdog) is never reclaimed mid-flight, and a retry that races
a still-wedged orphan gets `lease_unavailable` and stays on the retry ladder (never
a partial-PTY handback). When the machine wakes, the retry's
`/copy` captures the clean clipboard and the workflow proceeds; if it stays
wedged past the retry budget, it escalates visibly at the established floor. The
latch always releases.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AI_WHISPER_CLIPBOARD_IO_TIMEOUT_MS` | `8000` | Per-exec timeout for `pbpaste` and the `changeCount` helper. |
| `AI_WHISPER_CAPTURE_WATCHDOG_MS` | `20000` | Outer deadline on the whole capture await in the relay. |
| capture-lease `ttlMs` (derived) | `watchdogMs + margin` (≥ `25000`) | Lease hold ceiling, wired from the watchdog env so it stays ≥ watchdog; a *settling* capture (≤ watchdog) is never reclaimed mid-flight. A watchdog-abandoned orphan may be age-reclaimed later (safe — see *Lease safety*). Floor is `DEFAULT_LEASE_TTL_MS` (raised from 5000 to 25000). |
| `AI_WHISPER_AUTO_HANDBACK_MAX_ATTEMPTS` | `3` | (existing) Retry-ladder attempt budget; now also bounds timeout retries. |
| `AI_WHISPER_AUTO_HANDBACK_RETRY_MS` | `10000` | (existing) Spacing between retry attempts. |

**Value rationale.** Normal `pbpaste`/`changeCount` latency is <50ms; legitimate
worst cases (large `/copy` payload, heavy load, and especially the `pboard`
warm-up spike right after wake) can reach a few seconds. The timeout must clear
those so it never kills a capture that would have succeeded — the asymmetry
favors a generous value, since the only cost of "too long" is slightly slower
rejection on a true hang, which the watchdog caps anyway. `8000` gives
comfortable headroom.

The watchdog must remain the *outer* bound. Worst case before
`captureHandbackText` rejects is ≈ 2 × the per-exec timeout (the `changeCount`
read consumes its window and returns null, then `pbpaste` consumes its window
and throws) ≈ 16s. `20000` keeps per-exec timeouts producing the clean reject
path and leaves the watchdog a pure backstop for non-execFile hangs, while
clearing the healthy-capture ceiling (~6–8s) with room. A single knob covers
both execs; the `changeCount` helper normally returns in <50ms, and the 8s
window only bites when it is wedged — exactly the case being bounded. Keeping
`RETRY_MS` (10000) above the IO timeout (8000) lets an orphaned capture free its
lease before the retry tick in the common case; with token-scoped release this
ordering is now a performance nicety, not a correctness requirement (a late
orphan release can no longer clobber the retry's lease either way).

The lease TTL must stay **≥ the watchdog deadline**: it is derived from the
watchdog env rather than hardcoded, so tuning the watchdog up can never silently
re-open the mid-capture-reclaim race. It need not (and should not) span the whole
retry budget — orphan overlap past TTL is made safe by benign-overlap +
token-scoped release + result discard, and `lease_unavailable` keeps a
lease-blocked retry off the PTY path (see *Lease safety under longer captures*).

Both new values are env-tunable, so neither is load-bearing.

## Testing

Deterministic; no real sleep or real `pboard`.

- **L1 / changeCount:** `makeChangeCountReader` with an injected `runHelper` that
  rejects → resolves to `null`; assert the configured `timeoutMs` is threaded to
  the default execFile path (via an injectable execFile/`execFileText` or option
  spy).
- **L1 / captureHandbackText (two cases):** (a) a `runCapture` that rejects with a
  `CaptureIoTimeoutError` makes `captureHandbackText` return
  `{ status: "timed_out", text: null }` — it does NOT propagate — and the lease is
  released by the `finally`; (b) a `runCapture` that rejects with a *generic*
  (non-timeout) error propagates unchanged, with the lease still released by the
  `finally` (no hang, no lease leak). The token threaded to the release is the one
  returned by the acquire.
- **L3 / relay watchdog (key test for the reported symptom):** with a
  `captureHandbackText` that never settles and controlled time, advancing past
  the watchdog deadline clears `autoHandbackInFlight`, increments the retry
  attempt (does NOT hand back), and a subsequent idle tick can re-fire; assert
  this holds for **both** empty and non-empty PTY turn text (the non-empty case
  is the Mode D regression guard — it must retry, not deliver empty). On budget
  exhaustion it delivers at the escalate floor.
  - Harness gotcha (from Mode C/D): `makeAcceptedBroker` hardcodes
    `turnOwner`/`targetAgent = "claude"`, so the test's `currentAgent` MUST be
    `"claude"` or `getAcceptedHandoff` returns null and the auto-handback path
    never runs.
- **L1 timeout → relay retry (Blocking-1 regression guard):** a `runCapture` that
  rejects with a `CaptureIoTimeoutError` makes `captureHandbackText` return
  `{ status: "timed_out" }`; assert the relay sets `captureTimedOut`, takes the
  retry branch (increments `attempts`, does **not** hand back) **with non-empty PTY
  turn text**, and re-fires on a later tick. This is the path that fires *before*
  the watchdog under defaults, so it must be covered independently of the
  never-settles watchdog test — a null-clip-only assertion would pass while the
  product still halts.
- **Lease / TTL under longer captures (Blocking-2 guard):** with an injected `now`
  clock, a holder whose age is < the raised `ttlMs` is NOT reclaimable — a second
  `acquireCaptureLease` returns falsy (no concurrent capture) — while a dead-pid
  holder is still reclaimed immediately regardless of age (crash recovery intact).
- **Lease / token-scoped release (Blocking-2 guard):** acquire as A (token A), age
  it past TTL, acquire as B from the same collab (token B);
  `releaseCaptureLease(db, collab, A)` is a no-op (B's lease intact) and
  `releaseCaptureLease(db, collab, B)` clears it. Guards the orphan-clobber race.
- **Lease / pid-scoped teardown release (round-3 Blocking guard):** with a lease
  held by `(collab, pidB)`, `releaseCaptureLeaseForHolderPid(db, collab, pidA)`
  (a *different* pid, same collab — the reconnect case) is a **no-op**, while
  `releaseCaptureLeaseForHolderPid(db, collab, pidB)` clears it. Proves the mount
  teardown frees only its own lease and cannot clobber a reconnected same-collab
  mount running under a different pid.
- **Lease-contention routing (round-2 Blocking guard):** a `captureHandbackText`
  that returns `{ status: "lease_unavailable" }` makes the relay set
  `captureTimedOut` and retry; assert it does **not** set `leaseDegraded` and does
  **not** deliver the PTY turn even with non-empty PTY turn text — distinguishing
  it from an interference `degraded_pty_only`, which still PTY-delivers.
- **Orphan-timeline / no double-deliver, no PTY (round-2 Blocking guard):** drive
  the default timeline with controlled time — capture never settles, watchdog fires
  at its deadline, then the retry tick occurs while the orphan still holds the lease
  (age between watchdog and TTL, and again past TTL). Assert the retry takes the
  `captureTimedOut` branch (no handback, no PTY delivery with non-empty PTY turn
  text), that no *second* handback is ever delivered, and that budget exhaustion
  escalates at the floor — i.e. the orphan and the retry never both deliver.

## Files touched & staging

Six source files plus tests (the lease reconciliation adds the broker file the
first review round flagged as missing). The implementation plan stages this as
four independently-testable steps. Steps 2–4 touch ≤2 files each; step 1 is larger
only because a lease-API signature change must update every call site in the same
commit to keep the build green (a mechanical propagation, still independently
testable via the lease unit tests):

1. **Lease reconciliation (broker + call sites):**
   `packages/broker/src/storage/clipboard-capture-lease.ts` — raise
   `DEFAULT_LEASE_TTL_MS`; `acquireCaptureLease` returns its `acquired_at` token;
   `releaseCaptureLease` becomes token-scoped (`db, collabId, token`); add the
   pid-scoped `releaseCaptureLeaseForHolderPid(db, collabId, pid)` for terminal
   cleanup. **Atomically update both existing call sites** so it compiles:
   `capture-handback-text.ts` (capture the token on acquire; token-scoped
   `finally` release) and `mount-session-main.ts` `stop()` (swap the bare
   collab-only release for the pid-scoped `releaseCaptureLeaseForHolderPid(...,
   process.pid)`). Lands first because the longer capture windows are unsafe
   without it. No schema migration (reuses the existing `acquired_at` column as the
   token). NOTE: `capture-handback-text.ts` and `mount-session-main.ts` are also
   touched in later steps (status logic / env wiring) — that is fine; the concerns
   are disjoint.
2. **L1 — execFile timeouts + tagged timeout:** `clipboard-handback-capture.ts`
   (exported `CaptureIoTimeoutError` + `timeout`/`killSignal`),
   `clipboard-change-count.ts` (`timeout`/`killSignal`).
3. **Timeout plumbing + L3 watchdog:** `capture-handback-text.ts` (tagged-timeout →
   `timed_out` status; lease-acquire failure → `lease_unavailable` status — the
   token threading itself lands in step 1), `mounted-turn-owned-relay.ts`
   (watchdog race; `timed_out` and `lease_unavailable` → `captureTimedOut`; reserve
   the `degraded_pty_only` PTY fallback for interference-exhaustion only; add
   `captureTimedOut` to the retry condition).
4. **Env wiring:** `mount-session-main.ts` — resolve the I/O-timeout, watchdog, and
   derived lease-TTL knobs and pass them down. (Its teardown-release call-site
   change already landed in step 1.)

## Implementation notes / gotchas

- **Do not run `npx prettier --write`** on these files. Prettier is NOT a CI gate
  in this repo (only eslint lint / typecheck / build / test are); eslint enforces
  quotes/semi/comma-dangle but NOT indentation, so a prettier pass reformats the
  whole file against the wrong width and produces noisy, wrong diffs.
- The `finally` that clears `autoHandbackInFlight` is mandatory on **every** exit
  (retry return, timeout, delivery, throw) — a leaked reservation wedges
  auto-handback for the whole session.
- `captureTimedOut` retry is scoped to the timeout signal only; it must not widen
  the existing Mode A no-retry bucket (present short clip) or the lease-degrade
  PTY-fallback path, which keep their current handling.
- The timeout must reach the relay as the typed `timed_out` result (or, for a
  never-settles hang, the watchdog) — **never** as a bare null clip. A bare null
  clip on non-empty PTY is the Mode D no-retry bucket and halts. Add the
  `timed_out` branch to the relay's capture-result handling *before* the
  `degraded_pty_only` else, or a timeout is misclassified as a lease-degrade and
  delivers the partial PTY turn instead of retrying.
- Lease TTL must stay **≥ the watchdog deadline** at all times; wire it from the
  watchdog env (`watchdog + margin`), never a separate hardcoded constant that can
  drift below the watchdog.
- `releaseCaptureLease` is token-scoped — always pass the token returned by
  `acquireCaptureLease`; a collab-only release can clear a newer lease. **No bare
  collab-only `releaseCaptureLease(db, collabId)` call may remain.** The only two
  call sites are the per-capture `finally` (token-scoped) and the mount-teardown
  cleanup, which uses the pid-scoped `releaseCaptureLeaseForHolderPid(db, collabId,
  process.pid)` (it has no per-acquisition token, must free only this mount's own
  leases, and must not clobber a reconnected different-pid mount). Changing the
  signature without updating *both* sites breaks the build — they land together in
  the lease step.
- A bounded lease-acquire **failure** must return `lease_unavailable` and route to
  the `captureTimedOut` retry ladder — **never** `degraded_pty_only`/PTY delivery.
  `degraded_pty_only` is reserved for interference-exhaustion (clip clobbered by
  genuine foreign writes) only.
- Do **not** try to make the watchdog-abandoned orphan unreclaimable by inflating
  TTL to span the retry budget. TTL stays `watchdog + margin`; orphan overlap is
  already safe via benign-overlap + token-scoped release + result discard, and a
  budget-spanning TTL would couple it to four knobs and block cross-collab capture
  for minutes.

## Risks & trade-offs

- **False timeouts under extreme load** → an extra retry. Mitigated by the
  generous default and env tunability.
- **Orphaned capture after a watchdog fire** still holds the lease until it
  finally settles. A *settling* capture (≤ watchdog) is never reclaimed mid-flight;
  a non-settling orphan may be age-reclaimed by a later retry, which is safe
  (benign overlap + token-scoped release + result discard — see *Lease safety*). A
  retry that races a still-held orphan returns `lease_unavailable` and stays on the
  `captureTimedOut` retry ladder — it never delivers partial PTY, never deadlocks,
  and never produces a *successful* double capture.
- **No PTY fallback on timeout** (deliberate): during sleep the agent is frozen
  and its PTY text may be a partial turn; retry waits for a clean post-wake
  capture, matching the codebase's no-false-handback philosophy. The budget floor
  still escalates a genuinely stuck capture.

## Prior art

This is effectively a fifth capture-failure mode ("capture timeout") joining the
documented ladder: Mode A (claude short reply, clip>0), Mode B (codex large
turn), Mode C (clip=0 AND turn=0 → `no_response_captured`, fixed with the
retry-on-empty ladder + `autoHandbackInFlight` guard), Mode D (slow `/copy`
read-before-write race, empty-clip confident-miss, fixed with re-poll +
`emptyClipConfidentMiss` retry). The timeout reuses the same retry ladder.
