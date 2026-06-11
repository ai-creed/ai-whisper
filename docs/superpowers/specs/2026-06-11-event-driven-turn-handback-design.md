# Event-Driven Turn Handback for claude/codex — Design Spec

**Status:** Approved design, pending implementation plan
**Date:** 2026-06-11
**Scope:** Replace the clipboard-based handback capture for the PTY-scraped
providers (`claude`, `codex`) with a push-based turn-completion event channel,
unifying all three providers (incl. `ezio`) under one event-driven handback. This
includes bringing `ezio`'s existing event handler under the same
turn-selection/handback-fidelity discipline, which **fixes the 2026-06-10
drafting-notes halt** that motivated this work — the recorded failing path is in
scope, not deferred.
**Out of scope:** Deletion of the existing clipboard pipeline. The event path is
introduced as a gated fast-path with the clipboard path retained as fallback.
Removing the clipboard stack (lease, `changeCount`, classifier, retry ladders) is
a separate follow-up spec, gated on this one proving out.

---

## 1. Motivation

The current handback capture for `claude`/`codex` is the project's largest source
of shipped halts (CHANGELOG 0.2.1 → 0.5.4). It is passive: the relay waits for the
mounted pane to go idle, then injects `/copy`, reads the macOS clipboard via
`pbpaste`, and classifies the result. Reliability comes from a stack of defenses
around an inherently racy shared-clipboard RPC — host-global lease,
`NSPasteboard.changeCount` interference detection, per-agent `/copy` signature
learning, clip-vs-PTY similarity validation, and several retry ladders. It is also
macOS-bound.

`ezio` avoids the clipboard machinery because it is protocol-native: turn
completion is an explicit event (`onTurnFinished`) carrying the reply, delivered
directly via `handbackResolvedContent`.

Both PTY-scraped providers expose a **push** turn-completion mechanism that also
carries the final message — so the same event-driven shape `ezio` uses can be
extended to them, collapsing the clipboard stack.

**Event-native does not mean handback-fidelity is solved.** A push event removes
the clipboard *capture* race, but it does not by itself guarantee that the event
carries the agent's *final answer* rather than an intermediate turn. The
2026-06-10 incident
(`docs/superpowers/bugs/2026-06-10-sdd-reviewer-handback-rejected-as-drafting-notes.md`)
is the proof: a reviewer mounted as `ezio` — already on the event-native path —
had its second-turn handback delivered as drafting/scratchpad text ("Let's
draft", "Maybe", "...", "Need include") instead of the completed review matrix,
and the evaluator rejected it as drafting notes, halting the workflow. The cause
sits in event-native turn selection: `create-ai-ezio-live-session.ts` fires the
handback on the `idle` event using the *last* `assistant_turn_finished` content,
so an intermediate narration/planning turn that finishes (and an `idle` observed)
before the real answer is composed is what gets relayed. Extending events to
`claude`/`codex` inherits this exact class of failure — `codex notify` fires per
`agent-turn-complete` and a turn can complete mid-composition. This design must
therefore harden **turn selection**, not just turn *capture* (Section 4.3), and
that hardening applies to **all three event providers — including `ezio`'s
existing `create-ai-ezio-live-session.ts` handler, whose defect caused this
halt**. Fixing the recorded failing path and preventing the class from recurring
for `claude`/`codex` are the same fidelity discipline applied uniformly, so this
deliverable fixes the 2026-06-10 incident rather than deferring it.

### Feasibility — verified end-to-end (2026-06-11 throwaway smoke)

| | claude `Stop` hook | codex `notify` |
|---|---|---|
| Fires | per assistant turn (verified in headless `-p`, so interactive too) | per turn — **interactive TUI only** (NOT `exec`) |
| Final message | `last_assistant_message` (exact, no parse) | `last-assistant-message` (exact) |
| Correlation keys | `session_id`, `transcript_path`, `cwd` | `thread-id`, `turn-id`, `cwd`, `client`, `input-messages` |
| Channel | command hook → runs arbitrary program | `notify=["prog"]` → program gets event JSON as final argv |
| Config injection (per-launch) | `--settings <file-or-json>` (additive) | `-c notify=[...]` (process-scoped override) |
| Autonomy flag | survives `--dangerously-skip-permissions` | survives `--dangerously-bypass-approvals-and-sandbox` |

Both deliver the exact final message plus correlation keys with no clipboard
involvement. Versions verified: claude 2.1.172, codex 0.137.0.

---

## 2. Goals / Non-goals

**Goals**

- A push-based turn-event handback for `claude` and `codex`, delivered through the
  existing `handbackResolvedContent` path (the same one `ezio` uses).
- The event is a **gated fast-path**: it only resolves a handback when a workflow
  is active and the event is relevant to the in-flight handoff. On any doubt it
  falls back to the existing idle-poll + `/copy` capture. A missed or dropped
  event never halts a workflow.
- **Handback fidelity:** the resolved handback must be the agent's completed
  answer, never an intermediate drafting/narration turn. An event that looks like
  mid-composition is retried/deferred, not delivered (Section 4.3). This is the
  direct lesson of the 2026-06-10 ezio drafting-notes halt.
- **Fix the recorded failing path.** Apply the Section 4.3 fidelity discipline to
  `ezio`'s existing `create-ai-ezio-live-session.ts` handler so the 2026-06-10
  drafting-notes halt is fixed *by this deliverable* — the same discipline that
  newly guards `claude`/`codex` also corrects the one event provider that already
  failed. Reproduction-gated (Section 4.3), per the unverified-hypothesis caveat
  in the bug report.
- A provider-agnostic `EventReceiver` abstraction with a concrete handler per
  provider.
- Persistent, queryable logging of every received event and every shim invocation,
  self-pruned after a retention window, for debuggability.
- Zero mutation of the user's `~/.claude`, `~/.codex`, or repo working tree.

**Non-goals**

- Deleting the clipboard pipeline (separate follow-up).
- Re-architecting `ezio`'s protocol or session model beyond the turn-selection
  fidelity fix. The fix adopts the Section 4.3 discipline inside the existing
  handler (idle-settling + shape guard); it does not redesign the ezio event model
  or the `onTurnFinished`/`idle` contract.
- Non-macOS clipboard support (the fallback remains macOS-bound; the event path is
  cross-platform on its own, but that is incidental, not a goal here).

---

## 3. Architecture

### 3.1 Components

- **`EventReceiver` (abstract) + per-provider handlers.** Each handler parses its
  provider's raw payload and normalizes it into a common `TurnEvent`. claude
  handler parses the Stop-hook JSON (and, when needed, the triggering user message
  from `transcript_path`); codex handler parses the notify JSON.

- **Turn-event shim.** A dependency-free Node program shipped in the package bin.
  The provider CLI spawns it on turn completion. It reads the provider payload
  (claude: stdin; codex: final argv), derives the destination socket path from the
  event's `cwd`, appends a one-line arrival log, connects to the mount's socket,
  sends the normalized `TurnEvent`, and exits. It carries no `better-sqlite3` or
  other heavy dependency — a `net.connect` client and a file append only.

- **Mount socket listener.** Each mount listens on a Unix domain socket at
  `<stateRoot>/sockets/<workspaceId>-<provider>.sock`. On receipt it routes the
  `TurnEvent` into the relay gate, in-process (the mount already holds the relay
  state: `getAcceptedHandoff`, `handbackResolvedContent`).

- **Relay gate.** Lives in `mounted-turn-owned-relay`. Applies the workflow gate
  and relevance gate (Section 4) and either resolves the handback or defers to the
  existing idle-poll/`/copy` path.

- **Diagnostics.** A new `relay_turn_event_diagnostics` table (mount-side decision
  log) plus the shim's daily JSONL arrival log (Section 7).

- **Config injection.** Per-launch CLI flags wired into the provider launch argv
  (Section 6).

### 3.2 Normalized `TurnEvent`

```
TurnEvent {
  provider:          "claude" | "codex"
  workspaceId:       string        // workspaceIdFromPath(cwd)
  cwd:               string
  sessionOrThreadId: string        // claude session_id / codex thread-id
  turnId:            string | null // codex turn-id; null for claude
  message:           string        // authoritative final assistant text
  inputMessages:     string[]      // triggering input(s) for relevance
  receivedAt:        string        // ISO timestamp, stamped by the shim
}
```

---

## 4. Gating

Events fire on **every** assistant turn, whether or not a workflow is running. The
relay therefore treats an event as a candidate, never as an unconditional
handback.

### 4.1 Workflow gate

The event resolves a handback only if there is an accepted, autonomous handoff
awaiting handback for this collab. This reuses existing relay state:

- `getAcceptedHandoff()` returns a non-null accepted handoff,
- `autoHandbackFiredFor` is not yet set for it (handback not already delivered),
- `isAutonomousHandoff(handoffId)` is true (workflow `running`, chain `active`).

If the gate fails, the event is logged as `ignored_no_workflow` and dropped. No
fallback is triggered — there is simply nothing to deliver.

### 4.2 Relevance gate

Given an accepted handoff awaiting handback, the relay must confirm this turn is
the response to *that* handoff (not an unrelated turn while the workflow is
active — e.g. an operator interjection).

- **Input correlation (both providers, primary).** Compare the turn's triggering
  input against the request text the relay injected for the accepted handoff.
  codex provides `input-messages` directly; claude's triggering user message is
  read from `transcript_path`. A sequence backstop ("first Stop since our
  injection for this accepted handoff") covers the case where the transcript read
  is unavailable. Match is by normalized identity or containment.
- **Output corroboration (codex bonus).** Where a reliable PTY scrape is available
  (codex), additionally require `containment(message, scrapedTurnText)` to clear a
  threshold. This is deliberately **not** applied to claude: claude's full-screen
  TUI produces cursor-positioned output that `normalizeCapturedOutput` cannot
  reconstruct, so the scrape is lossy and would false-negative against a correct
  event — the exact reason today's classifier falls back to `/copy` for claude.

**Outcomes:**

- **Relevant** → deliver the event's `message` via `handbackResolvedContent`
  (`captureStatus: "ok"`), burn the `autoHandbackFiredFor` guard, log `delivered`.
- **Irrelevant** → log `fallback_to_copy`, do **not** burn the guard; the existing
  idle-poll + `/copy` auto-handback path runs unchanged.

The event path is strictly an optimization over the proven path: any miss, doubt,
or absent event leaves the existing mechanism in control.

### 4.3 Turn-selection / handback fidelity

The relevance gate confirms an event belongs to the in-flight handoff; this gate
additionally confirms it is the agent's *completed answer* and not an intermediate
turn. This is the class behind the 2026-06-10 ezio halt: an agent may emit a
planning/drafting turn that turn-completes before the real answer, and a naive
"deliver the turn that just completed" rule relays the scratchpad.

Defenses, in order:

- **Settle on the last turn before quiescence, not the first.** A handback is
  resolved from the turn-complete that is followed by genuine idle for the session,
  not from the first `turn_finished`/`Stop`/`agent-turn-complete` seen. For `claude`
  this is largely structural — `Stop` fires once per submitted prompt, so a
  plan-then-answer sequence inside one prompt yields one `Stop` carrying the final
  message. For `codex` (`notify` per `agent-turn-complete`) and `ezio` (`idle`
  after `assistant_turn_finished`), multiple completions are possible, so the relay
  takes the latest and re-arms on each new completion until idle settles.
- **Mid-composition shape guard.** Before delivering, reject a candidate whose
  `message` is empty or matches a drafting/scratchpad shape (the evaluator's own
  drafting-notes signal — fragments like "Let's draft", "Maybe", trailing "...",
  "Need …" with no structured content). A rejected candidate is **retried/deferred
  to a later turn-complete**, mirroring the existing clipboard Mode-C retry ladder —
  it is **not** delivered. Delivering a mid-composition fragment is exactly what
  escalated and halted the workflow on 2026-06-10, so the capture layer must absorb
  it via retry rather than push it to the evaluator.
- **Fallback on exhaustion.** If no clean completed turn resolves within the retry
  budget, fall back to idle-poll/`/copy` for `claude`/`codex`. `ezio` has no
  clipboard fallback, so on exhaustion it delivers the last settled turn and
  relies on the evaluator backstop — but idle-settling (above) is what prevents
  the transient-idle capture from arising in the first place.

The shape guard is a capture-side belt; the evaluator's drafting-notes rejection
remains the authoritative backstop. The point is that the capture layer should
*retry* on an obvious mid-composition handback instead of delivering it and
forcing the evaluator to halt.

**Applied to `ezio`'s existing handler (the 2026-06-10 fix).**
`create-ai-ezio-live-session.ts` currently fires the handback on the first `idle`
after any `assistant_turn_finished`, using that turn's content — so a transient
`idle` between a planning turn and the real answer relays the planning turn, which
is the recorded failure. The fix brings this handler under the discipline above:
do not resolve on a transient `idle` that is followed by further assistant
activity for the same handoff; settle on the turn preceding genuine quiescence,
and run the shape guard before delivery. Because the bug report's trigger is an
explicitly **unverified hypothesis**, the implement phase is **reproduction-gated**:
land a RED test driving the recorded sequence (drafting `assistant_turn_finished`
→ transient `idle` → real-answer `assistant_turn_finished`) and confirm the exact
trigger *before* finalizing whether the fix is idle-settling, a turn-boundary
signal, or both. This is what makes the recorded failing path fixed by this
deliverable rather than deferred.

---

## 5. Workspace isolation / no socket collision

The socket path is `<stateRoot>/sockets/<workspaceId>-<provider>.sock`, where
`workspaceId = workspaceIdFromPath(cwd)` = `sha256(realpathSync(absolute cwd))`
sliced to 16 hex (`packages/cli/src/runtime/workspace-id.ts`).

- Two worktrees of one repo are two distinct canonical paths → two distinct
  workspace ids → two distinct sockets. **No collision.**
- The one-active-collab-per-workspace invariant is itself path-keyed, so per
  `(workspaceId, provider)` there is at most one mount. The `-<provider>` suffix
  separates the two mounts (claude, codex) that may share one worktree.
- Consistency holds end-to-end: the mount launches the agent with `cwd =`
  workspace root, so the agent's `cwd` (reported in the hook/notify payload)
  equals the mount's workspace root. The shim runs the same
  `workspaceIdFromPath` canonicalization, resolving symlink-class mismatches
  (e.g. `/tmp` → `/private/tmp`, observed live in the smoke) on both sides.
- The 16-hex slice keeps the socket path within the ~104-char Unix-socket path
  limit.
- Sockets live in a global `<stateRoot>/sockets/`, shared across worktrees;
  filenames keep them distinct.

The only way to collide is two same-provider mounts on the identical canonical
path, which the invariant forbids.

---

## 6. Config injection and teardown

Both providers are configured **per launch** via CLI flags, so the configuration
is process-scoped and torn down automatically when the agent process exits. There
is no persistent mutation of `~/.claude`, `~/.codex`, or the user's repo.

- **claude:** launch with
  `--settings <stateRoot>/providers/claude/<workspaceId>.json`. That file contains
  only our `Stop` hook:
  `command: "<shim> --provider claude --socket-dir <stateRoot>/sockets"`. The
  `--settings` flag loads *additional* settings (verified via `claude --help`:
  "Auth, model ... settings still apply"), so the user's own settings and hooks
  are preserved and also fire. claude pipes the payload on the hook's stdin.
- **codex:** launch with
  `-c 'notify=["<shim>","--provider","codex","--socket-dir","<stateRoot>/sockets"]'`.
  The `-c/--config` flag overrides a single config value for this process only,
  inheriting the user's real `~/.codex/config.toml` (model, MCP, skills,
  `AGENTS.md`) for everything else. codex appends the event JSON as the final argv
  to the configured program.

**Artifacts owned (all under `stateRoot`):**

1. The shim — static, dependency-free, shipped in the package bin; installed once,
   not per mount.
2. The claude `--settings` file — regenerated each mount; harmless if stale.
3. The listening socket — created by the mount on start, unlinked on graceful
   shutdown; orphans swept on broker startup (crash case).
4. Logs (Section 7).

**Teardown:** configuration requires no teardown (process-scoped flags). The mount
unlinks its socket on shutdown; a broker-startup sweep removes orphaned sockets
with no live owner. No restore-on-crash logic and no user-config risk.

**Caveats:**

- codex `-c notify` replaces the user's own `notify` program (e.g. a desktop
  chime) for ai-whisper-driven sessions only; normal codex usage is untouched. An
  optional enhancement is to chain to the user's configured notify from within the
  shim.
- claude `--settings` is additive, so the user's own `Stop` hooks also run. Our
  hook only writes-and-exits-0, never blocks, so it does not interact with the
  Stop block cap.
- Implementation must confirm codex `-c notify=[...]` array-value parsing (the
  help states the value is parsed; high confidence).

---

## 7. Logging and retention

Two persistent layers, covering both "what the relay decided" and "did the event
even arrive".

- **Mount-side decision log (DB, primary).** A new `relay_turn_event_diagnostics`
  table in `state.db`, mirroring `relay_capture_diagnostics`. Columns: `received_at`,
  `provider`, `workspace_id`, `cwd`, `session_or_thread_id`, `turn_id`,
  `workflow_active`, `collab_id`, `workflow_id`, `chain_id`, `handoff_id`,
  relevance verdict and scores (`input_correlated`, `containment_score`), `action`
  (`delivered` | `ignored_no_workflow` | `fallback_to_copy`), message length, and
  a 200-char message sample gated by the existing `AI_WHISPER_NO_CAPTURE_SAMPLES`.
- **Shim-side arrival log (file, belt-and-suspenders).** The critical silent
  failure is an event that fires but never reaches the mount (stale socket, mount
  down, wrong path) — which produces no mount-side row. The dependency-free shim
  therefore appends one JSONL line to
  `<stateRoot>/logs/turn-events-YYYY-MM-DD.jsonl`: timestamp, provider, `cwd`,
  target socket path, connect result (`ok` | `refused` | `error`), payload bytes.

**Retention / prune.** Default 3 days, configurable via
`AI_WHISPER_EVENT_LOG_RETENTION_DAYS`. Pruning runs on broker startup, mirroring
`sweepStaleCaptureLease`: DB rows older than the window are deleted; dated log
files older than the window are unlinked (whole-file delete, no rewrite).

---

## 8. Error handling and edge cases

| Case | Behavior |
|---|---|
| Stale socket / mount down | Shim connect fails → logs `refused` → exits → existing idle-poll/`/copy` delivers. Self-healing. |
| claude `StopFailure` (API error) | No `Stop` fires → no event → idle-poll/`/copy` handles as today. |
| Empty / tool-only final turn | Empty `message` → fallback to `/copy`, whose retry ladder already handles empties. |
| Intermediate drafting/planning turn completes before the answer (2026-06-10 ezio class) | Turn-selection settles on the last turn before idle; shape guard rejects mid-composition fragments → retry/defer to a later turn-complete, never deliver the scratchpad (Section 4.3). |
| Operator interjects mid-workflow | Extra turn-complete fires → input correlation mismatch → ignored; no false handback. |
| Event with no accepted handoff | Workflow gate drops it (`ignored_no_workflow`). |
| Double delivery (event + idle-poll race) | Shared `autoHandbackFiredFor` one-shot guard — whichever resolves first sets it; the other sees it set and no-ops. |
| Crash teardown | Socket orphan swept on broker startup; config flags process-scoped (nothing to restore); logs age-pruned. |

When the event path is enabled for a provider, the relay sets
`suppressQuiescenceHandback`-equivalent behavior so the quiescence handback does
not *also* fire — but the explicit idle-poll/`/copy` fallback remains reachable
for the relevance-miss and no-event cases. (Exact interaction with the existing
`suppressQuiescenceHandback` flag, today set only for protocol-native sessions, is
settled in the implementation plan.)

---

## 9. Rollout

- **Per-provider enablement, three sources (precedence: flag > env > default).**
  - CLI flag: `whisper collab mount --turn-events claude,codex` — the primary,
    discoverable knob (shows up in `--help`). Mirrors the existing dashboard
    `--window` flag's flag > env > default precedence.
  - Env var: `AI_WHISPER_TURN_EVENTS=claude,codex` — the runtime kill-switch
    (unset a provider to instantly revert it to pure clipboard, no redeploy).
  - Default: empty (off) — upgrading users get zero behavior change.
- **Loud startup signal.** Each mount logs its resolved event-source state at
  launch, e.g. `[ai-whisper] turn-events: claude=ON codex=off`, so a forgotten
  flag is visible on every mount rather than silently leaving the feature off. A
  bare env var is easy to forget; the startup line makes the enablement state
  self-evident and is the cheap guard against "I thought it was on".
- Enabling is low-risk: the fallback is always present and the event path never
  regresses behavior. Roll out per provider after the
  `relay_turn_event_diagnostics` rows confirm events fire, correlate, and deliver
  on real runs.
- Once the event path is proven across providers, a follow-up spec removes the
  clipboard stack (lease, `changeCount`, classifier, retry ladders) and the macOS
  coupling that comes with it.

---

## 10. Affected code (rough)

- **New:** turn-event shim bin; `event-receiver.ts` (abstract + claude/codex
  handlers); mount socket listener wiring; `relay_turn_event_diagnostics`
  repository + migration; retention sweep.
- **Modified:** `mounted-turn-owned-relay` (gate logic, reuse of
  `handbackResolvedContent`, quiescence suppression when events on);
  claude/codex launch argv in the adapters to add the injection flags;
  `state-root` for the `sockets/` and `logs/` directories; the
  `whisper collab mount` command to add the `--turn-events` flag, resolve
  enablement (flag > env > default), and emit the startup state log line.
- **Reused:** `handbackResolvedContent`, `getAcceptedHandoff`,
  `autoHandbackFiredFor`, `isAutonomousHandoff`, `computeContainment`,
  `workspaceIdFromPath`.

---

## 11. Testing

- **Unit:** `EventReceiver` normalization per provider, using fixtures captured
  from the real smoke payloads; relevance gate (input match/miss, codex
  containment corroboration); socket-path derivation including the two-worktrees
  no-collision case; retention prune (DB age delete, dated-file unlink).
- **Integration:** socket receipt → gate → `handbackResolvedContent` against a
  mock broker; the fallback path when the gate rejects or no event arrives.
- **Turn fidelity (RED-first, reproducing the 2026-06-10 ezio halt):** drive the
  recorded sequence into `create-ai-ezio-live-session.ts` — a drafting
  `assistant_turn_finished` ("Let's draft", "Maybe", "..."), a transient `idle`,
  then the real-answer `assistant_turn_finished` — and assert the delivered
  handback is the real answer, never the scratchpad. This RED test is what fixes
  the reported bug; the same fidelity assertion is then parameterized across
  `codex` (multiple `agent-turn-complete`) and `claude`.
- **End-to-end:** real claude `Stop` hook and codex `notify` driving a mounted
  session through to workflow delivery, formalizing the throwaway smoke. RED-first
  per provider: an event with non-matching input asserts fallback rather than a
  false handback.

---

## 12. Open questions (resolve in the plan)

- Exact reconciliation with the existing `suppressQuiescenceHandback` flag for
  claude/codex when events are enabled.
- Whether to chain codex `notify` to the user's previously-configured notify
  program.
- The precise input-correlation threshold and whether claude always reads
  `transcript_path` or relies on the sequence backstop first.
- The exact `create-ai-ezio-live-session.ts` handler change (Section 4.3) is in
  scope for this deliverable but pending the RED reproduction of the 2026-06-10
  event sequence — the precise trigger for the transient `idle` is an unverified
  hypothesis in the bug report, so the implement phase reproduces first, then
  finalizes whether the fix is idle-settling, a turn-boundary signal, or both.
- Whether the mid-composition shape guard (Section 4.3) should share one
  drafting-notes signal with the evaluator, to avoid drift between the
  capture-side guard and the authoritative backstop.
