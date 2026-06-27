# Antigravity Turn-Events via Lifecycle Hooks — Design

**Date:** 2026-06-27
**Status:** Approved design (empirically verified 2026-06-27), ready for planning
**Revision (2026-06-27, review):** Hardened the hook transport/gating contract per review. (1) agy hook routing no longer depends on a payload `cwd` — agy payloads have none — so the shim routes by a `--workspace-id` baked into the hook command (§5.1–5.2). (2) Parent-`conversationId` adoption now requires **positive identification** of the launched session (pinned id, workspace-scoped first event, or `workspacePaths` match); with no discriminator the global fallback adopts nothing and degrades to idle, so it can never adopt or capture an unrelated concurrent agy session — including one that fires first (§4.2, §5.3). Acceptance criteria 8–9 and tests added.
**Context:** ai-whisper — turn-end detection for a mounted Antigravity (`agy`) session, enabling `agy` to run as an autonomous workflow implementer/reviewer with reliable turn capture.

**Relationship to prior spec & to the merged implementation.** This is a standalone companion to `docs/superpowers/specs/2026-06-27-antigravity-adapter-design.md` (the base adapter design). It **supersedes** that spec's turn-events decisions — base §3 (D4/D5), §9 ("recognized-but-off, no hook"), §10 (`supportsLaunchHooks: false`), and the `turn-event.ts` row excluding `agy` from `TurnEventProvider`. Everything else in the base spec (package layout, relay parsing, dashboard, skill install, reconnect, build wiring) stands unchanged.

**Those base-spec turn-events decisions are already implemented and merged to `master`** via `feat/antigravity-adapter` (merge `3eff766`; turn-events commit `187f087 feat(agy): recognize agy turn-events token (pinned off, warn)`) — the **pin-off scaffolding** detailed in §1a. This spec therefore defines a *change to shipped code*, not greenfield work: it **removes** the pin-off scaffolding and **replaces** it with the hook integration. Where this spec disagrees with the merged pin-off behavior, **this spec wins.**

> **Verification note.** The agy hook behavior below was verified empirically against `agy` v1.0.13 on 2026-06-27 by registering probe hooks and capturing real payloads (quoted verbatim in §3 and §5). The base spec's earlier claim "agy has no turn-end hook" was an under-probe (it checked `agy --help` only); this spec corrects it. Two behaviors remain **to confirm in interactive mode** and are listed in §11 — the design accommodates either outcome.

## 1. Problem

A mounted `agy` session is a long-lived `node-pty` TUI. ai-whisper's shared mount runtime infers turn-end from an **idle timer** (`AI_WHISPER_IDLE_THRESHOLD_MS`, default 30 000 ms): when no PTY bytes arrive for the threshold, it declares the turn over, runs `/copy` capture, and hands off.

That heuristic relies on the agent emitting bytes continuously while working (an animated "thinking" spinner) — true for `claude`/`codex`, which *also* have turn-end hooks as the primary signal. `agy` has **no continuous spinner during quiet phases** (notably while a subagent runs), and the base spec assumed it had **no hook**. Result: during a quiet subagent wait > 30 s, ai-whisper would falsely declare turn-end, `/copy`-capture a half-finished screen, and hand off garbage. That makes `agy` unusable as an autonomous implementer/reviewer.

This spec resolves that by using `agy`'s lifecycle hooks as the turn-end signal (primary) plus a heartbeat (defense-in-depth), demoting the idle timer to a far-back fallback.

## 1a. Implemented baseline (pin-off scaffolding to remove)

`feat/antigravity-adapter` (merged `3eff766`) already shipped `agy` turn-events as recognized-but-pinned-off. This spec's job is to **replace** that scaffolding. The exact merged state, verified on `master`:

- `packages/cli/src/runtime/turn-events-config.ts` — `TurnEventsEnablement` already includes `agy: boolean`; `RECOGNIZED_TURN_EVENTS_TOKENS` already includes `"agy"`; `formatTurnEventsStartupLine` already prints `agy=…`. But `resolveTurnEvents` **pins `agy` to `false` in every branch** (default `{claude:true,codex:true,agy:false}`), and a helper `agyTurnEventsExplicitlyRequested(flag)` exists to emit a "no hook, staying off" warning (wired in `mount.ts`).
- `packages/cli/src/runtime/turn-event.ts` — `TurnEventProvider = Exclude<AgentType, "ezio" | "agy">` (agy **excluded**).
- `packages/adapter-antigravity/src/create-antigravity-provider.ts` — `getCapabilities().supportsLaunchHooks: false`.
- **No** `writeAgyHooksFile`, **no** `AgyEventReceiver`, **no** `agy` arm in `turn-event-shim.ts`, **no** `agy` event-path wiring in `mount-session-main.ts`.

So §6/§7 below are **deltas against this baseline**: remove the pin and the `agyTurnEventsExplicitlyRequested` warn, flip the default and capability, drop the `"ezio" | "agy"` exclusion, and add the hook-integration pieces that do not yet exist.

## 2. Goal & Non-goals

**Goal**
- Detect `agy` turn-end reliably in a mounted session via its `Stop` lifecycle hook, gated correctly so subagent completions and mid-turn pauses do not trigger capture.
- Keep the session "alive" (no false idle) during long work — including multi-minute subagent runs — via a hook-driven heartbeat.
- Integrate `agy` into ai-whisper's existing turn-event architecture (shim → socket → listener → relay) as a first-class hook-capable provider, alongside `claude`/`codex`.

**Non-goals**
- High-fidelity structured capture by reading `agy`'s `transcriptPath` JSONL (a noted enhancement, §4.5 — v1 reuses the shared `/copy` capture).
- Turn-events for any non-mounted path (companion `handleWork` is exit-driven and needs none).
- Auto-launch, attached sessions, and other base-spec scope items (unchanged there).

## 3. Verified agy hook behavior

`agy`'s `/hooks` exposes five lifecycle events:

| Event | Fires | Decision hook? |
|---|---|---|
| `PreToolUse` | before a tool call | yes (expects allow/deny) |
| `PostToolUse` | after a tool call | no |
| `PreInvocation` | before each **LLM invocation** (one model call) | no |
| `PostInvocation` | after each LLM invocation | no |
| `Stop` | when the agent **stops / goes idle** | no |

Crucially, "invocation" = a single LLM call, so `PreInvocation`/`PostInvocation`/`PreToolUse`/`PostToolUse` fire **many times per turn** (once per step of the agentic loop) — they are *not* turn boundaries, but they make an excellent **heartbeat**.

**`Stop` is the turn-end signal — but only when correctly gated.** Its payload carries `conversationId` and a `fullyIdle` boolean. In a run where the parent agent dispatched a subagent (`sleep 8 && echo`), three `Stop` events fired:

| `conversationId` | `fullyIdle` | `terminationReason` | meaning |
|---|---|---|---|
| `c84f932a…` (parent) | `false` | `NO_TOOL_CALL` | parent paused to dispatch the subagent — **not** done |
| `4452fbde…` (subagent) | `true` | `NO_TOOL_CALL` | subagent finished (different conversation) |
| `c84f932a…` (parent) | `true` | `NO_TOOL_CALL` | **true turn-end** |

→ **Turn-end ≙ `Stop` where `conversationId == <mounted parent conversationId>` AND `fullyIdle == true`.** It fires exactly once, at true completion; it is not fooled by the subagent's `Stop` (different `conversationId`) nor the parent's mid-turn pause (`fullyIdle == false`).

**Heartbeat density.** Across that same subagent run, the largest gap between consecutive hook fires was **~7 s** (the `PostToolUse` bracketing the 8 s `sleep`); during normal multi-step work, gaps are sub-second to ~3 s. The only way to exceed 30 s of hook silence is a *single* tool/command that itself blocks > 30 s — covered by the tool-in-flight bracket (§4.3).

**Verified payloads** (fields used by the receiver in bold):

```jsonc
// Stop
{ "artifactDirectoryPath": "...", "conversationId": "c84f932a-...",   // ← gate
  "error": "", "executionNum": 0, "fullyIdle": true,                  // ← gate
  "modelName": "gemini-3-flash-agent", "terminationReason": "NO_TOOL_CALL",
  "transcriptPath": ".../transcript_full.jsonl", "workspacePaths": [] }

// PreInvocation / PostInvocation (heartbeat)
{ "artifactDirectoryPath": "...", "conversationId": "...", "initialNumSteps": 5,
  "invocationNum": 1, "modelName": "...", "transcriptPath": "...", "workspacePaths": [] }

// PreToolUse (heartbeat + tool-in-flight open) / PostToolUse (close)
{ "artifactDirectoryPath": "...", "conversationId": "...", "modelName": "...",
  "stepIdx": 6, "toolCall": { "name": "run_command", "args": { "CommandLine": "...", "Cwd": "..." } },
  "error": "", "transcriptPath": "...", "workspacePaths": [] }
```

**Registration (verified).** Hooks live in `hooks.json` under a customization directory — workspace `.agents/hooks.json` or global `~/.gemini/config/hooks.json`. The schema is a **map of named groups** (not a top-level `hooks` key — the base-spec-era guess of `{"hooks":{...}}` is silently ignored):

```jsonc
{
  "<group-name>": {                       // a named group; optional "enabled": false to disable
    "PreToolUse":  [ { "matcher": "run_command", "hooks": [ { "type": "command", "command": "…", "timeout": 10 } ] } ],
    "PreInvocation":  [ { "type": "command", "command": "…" } ],   // shorthand form (no matcher/nested hooks)
    "Stop":           [ { "type": "command", "command": "…" } ]
  }
}
```

**Hook contract (verified).** `agy` passes the event payload as **JSON on the hook command's stdin**; the command returns a JSON object on **stdout** (e.g. `{"decision":"allow"}`). Decision hooks (`PreToolUse`) gate the action on that decision; observational hooks ignore it. Our integration always returns `{"decision":"allow"}` so hooks never gate `agy`'s behavior (§5.2).

## 4. Turn-end & capture design

### 4.1 Primary signal — the `Stop` hook
On mount, ai-whisper registers an `agy` hooks group whose commands invoke the existing **turn-event shim**. When a `Stop` event arrives whose `conversationId` matches the mounted session's parent and whose `fullyIdle == true`, the relay treats the turn as finished and runs capture + handoff. This replaces "idle == turn-end" as the primary mechanism (mirroring how `claude`'s `Stop` hook drives capture).

### 4.2 conversationId capture (positive identification only)
The mounted session does not know the parent `conversationId` until `agy` starts, so the mount runtime must adopt it from an early hook event — but it adopts **only an id positively identified as the session ai-whisper launched.** A bare "first event of any type" is unsafe under the global-hooks fallback (§5.3): the hook command bakes a fixed `--workspace-id` (§5.1) and agy payloads carry no `cwd`, so *every* `agy` process on the machine forwards to this mount's socket — an unrelated session can fire **first**. The runtime uses the strongest discriminator available:

1. **Pinned id (strongest; if `agy` accepts a caller-supplied conversation id — §11):** launch `agy` with a generated conversation id and gate `Stop` on exactly that id. No adoption step, no race, safe under any hooks file.
2. **Workspace-scoped hooks (race-free):** with `.agents/hooks.json` in the mount cwd (§5.3), only `agy` processes launched in this workspace load our group, so the first event received is necessarily ours — adopt its `conversationId`.
3. **Global hooks + `workspacePaths` discriminator:** adopt the `conversationId` from the first event whose `workspacePaths` contains the mount's launch cwd, distinguishing our session from unrelated `agy` sessions.
4. **No positive discriminator** (global hooks, `workspacePaths` empty, id not pinnable): the runtime **adopts no `conversationId` and performs no hook-based capture.** Hook events are ignored for turn-end and the mount degrades to the idle-timer fallback (§4.4, today's behavior), logging a loud "agy turn-events degraded — global hooks without a session discriminator" warning. This guarantees the mount never adopts an unrelated id nor captures an unrelated session's `Stop`, **even when that session fires first** (acceptance criterion 9). It is a **documented limitation, not a supported steady state**: reliable autonomous `agy` requires resolving §11 (workspace hooks load, `workspacePaths` populated, or id pinning), any of which lands in cases 1–3.

Once a parent id is adopted (cases 1–3), it is fixed for the session: `Stop` is accepted only for that id; subagent Stops (different id), mid-turn `fullyIdle == false` pauses, and any unrelated session's events are ignored. The runtime **never switches** to a different id mid-session, and **never adopts an id it cannot positively attribute to its own launch** — so a foreign session that fires first can neither become the parent nor have its `Stop` captured.

### 4.3 Heartbeat & tool-in-flight bracket (defense-in-depth)
Every hook event resets `lastActivityAt` (heartbeat), so the idle fallback never fires while `agy` is doing multi-step work. A `PreToolUse` opens a "tool in flight" state and the matching `PostToolUse` (same `stepIdx`) closes it; while a tool is in flight, the idle fallback is suppressed entirely (covers a single tool/command that blocks > 30 s). The `Stop` signal remains primary; this layer only guards against a missed/late `Stop`.

### 4.4 Idle fallback
The existing idle timer is retained as a last resort: if no `Stop` is observed and hooks have gone quiet (no heartbeat) beyond the threshold and no tool is in flight, the runtime falls back to the shared `/copy` capture. For `agy` this should be rare-to-never; it exists so a hook-delivery failure degrades to today's behavior rather than hanging.

### 4.5 Capture content
v1 reuses the shared capture unchanged: a confirmed turn-end triggers the existing `/copy` + PTY-text fallback + `classifyCapture` path (exactly the claude flow, where the `Stop` event triggers `/copy`). **Enhancement (non-goal for v1):** the `Stop` payload's `transcriptPath` points at a full JSONL transcript; reading the last assistant turn from it yields structured, scrape-free capture that could be more reliable than `/copy`. Deferred pending confirmation of the transcript format.

## 5. Hook registration & lifecycle

### 5.1 `writeAgyHooksFile` (analogue of `writeClaudeSettingsFile`)
A new writer emits/updates a single named group — `"ai-whisper-turn-events"` — inside the target `hooks.json`, registering:
- `Stop` → shim command (turn-end signal).
- `PreInvocation`, `PostInvocation`, `PostToolUse` → shim command (heartbeat).
- `PreToolUse` → shim command (heartbeat + tool-in-flight open; always returns allow).

The shim command is `<shimPath> --provider agy --socket-dir <socketsDir> --log-dir <logsDir> --workspace-id <workspaceId>` with a small `timeout` (e.g. `5`). Unlike claude/codex — whose payloads carry `cwd`, from which the shim derives the socket's workspace id — **verified `agy` payloads contain no `cwd`** (§3). The writer therefore **bakes the mount's `workspaceId` into the command** as the routing source; it is the same id the listener uses to name the socket (`${workspaceId}-agy.sock`). Because the schema is a **map of named groups**, the writer adds/removes only the `ai-whisper-turn-events` group, leaving any user-authored groups intact (non-destructive merge).

### 5.2 Shim behavior for `agy`
`turn-event-shim.ts` gains an `agy` arm that reads the payload from **stdin** (like `claude`; `codex` reads argv) and routes by the explicit `--workspace-id` argument rather than parsing `cwd` from the payload (agy has none — without this the shim's existing `cwd`-based router finds nothing and drops the event). It forwards the raw payload to `${socketDir}/${workspaceId}-agy.sock` tagged `provider: "agy"`, then prints `{"decision":"allow"}` to stdout so the hook never blocks `agy` (required for the `PreToolUse` decision hook, harmless for the rest). The `cwd`-from-payload routing for claude/codex is unchanged; `--workspace-id`, when present, takes precedence, and the agy arm never exits on a missing `cwd`. Must be fast and never error (a failing hook must not stall the agent).

### 5.3 File location & cleanup
- **Preferred:** workspace `.agents/hooks.json` in the mount's launch cwd — scoped to this workspace, naturally cleaned up. (Requires confirming mounted interactive `agy` loads workspace `.agents/` from cwd — §11.)
- **Fallback:** global `~/.gemini/config/hooks.json` — guaranteed to load, but **process-wide**: because the hook command bakes a fixed `--workspace-id` (§5.1) and agy payloads carry no `cwd`, *every* `agy` process on the machine forwards its hook events to this mount's socket. Safe use therefore depends on **positively identifying our session** per §4.2 — a `workspacePaths` match or a pinned conversation id. With no positive discriminator the runtime **disables hook-based capture and degrades to the idle timer** rather than risk adopting an unrelated session (even one that fires first). The named-group merge keeps it non-destructive.
- **Lifecycle:** install the group before launching `agy`; **remove the `ai-whisper-turn-events` group on teardown** (and restore any backup). Never leave our group behind in a global file.

## 6. What ships (integration with the turn-event stack)

| File | Change |
|---|---|
| `packages/cli/src/runtime/turn-event.ts` | Change the merged `TurnEventProvider = Exclude<AgentType, "ezio" \| "agy">` to `Exclude<AgentType, "ezio">` (drop the `\| "agy"` so the hook stack handles `agy`). |
| `packages/cli/src/runtime/turn-events-config.ts` | `TurnEventsEnablement.agy`, the `"agy"` token in `RECOGNIZED_TURN_EVENTS_TOKENS`, and the `agy=…` startup line are **already present** (no-op). **Delta:** in `resolveTurnEvents`, **remove the unconditional `agy:false` pin** so `agy` resolves like `claude`/`codex` (default on; allow-list when set; `off`/`none` disables). **Remove** `agyTurnEventsExplicitlyRequested(...)` and its "no hook" warning call in `mount.ts` (obsolete once the hook works). **Add** `writeAgyHooksFile(...)` — bakes `--workspace-id <workspaceId>` into the shim command so agy hooks route without a payload `cwd` (§5.1). |
| `packages/cli/src/bin/turn-event-shim.ts` | Add `agy` to the provider type and a stdin payload-read arm that routes by an explicit `--workspace-id` argument (agy payloads carry no `cwd`, so the existing `cwd`-based router would drop every agy event); the agy arm must not exit on a missing `cwd`. Always emit `{"decision":"allow"}` on stdout (§5.2). claude/codex `cwd` routing unchanged. |
| `packages/cli/src/runtime/event-receiver.ts` | New `AgyEventReceiver`: parse the agy payload; emit a turn-event only for `Stop` with `fullyIdle == true`; emit heartbeat/activity for the other events; expose `conversationId`, `transcriptPath`, `terminationReason`. |
| `packages/cli/src/runtime/mount-turn-event-listener.ts` | Dispatch to `AgyEventReceiver` when `provider === "agy"`. |
| `packages/cli/src/runtime/mount-session-main.ts` | Enable the event path for `agy` (`_eventEnabled`/`eventPathEnabled`/listener creation include `agy`). Adopt the parent `conversationId` only when **positively identified as ours** (§4.2: pinned id, workspace-scoped first event, or `workspacePaths` match); with no discriminator, adopt nothing and degrade to the idle timer. Never switch the adopted id mid-session, and never adopt a foreign id that fires first. On gated `Stop` → finish turn + capture; on other agy events → reset `lastActivityAt` and maintain tool-in-flight state. Install `writeAgyHooksFile` before launch; remove the group on teardown. |
| `packages/cli/src/runtime/providers.ts` | When mounting `agy` with turn-events on, invoke `writeAgyHooksFile` and ensure the shim is reachable (parallel to how claude’s `--settings <file>` is wired). No agy launch flag is needed — hooks come from the file, not argv. |

(The base adapter spec already covers the non-turn-events surfaces: the `adapter-antigravity` package, `agentTypes`/`relayTargets`, submit strategy, relay parsing, dashboard, skill install, reconnect, build wiring.)

## 7. Capabilities delta

`createAntigravityProvider().getCapabilities()` — flip **`supportsLaunchHooks`** from the merged `false` to **`true`**. All other fields unchanged: `supportsDirectPackets: true`, `supportsNormalization: true`, `supportsRelayInterception: true`, `supportsLocalBuffering: false`, `extensions: {}`.

## 8. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| H1 | Turn-end = `Stop` hook gated by `conversationId == parent` && `fullyIdle == true`. | Verified to fire exactly once at true completion; ignores subagent Stops and mid-turn pauses (§3). |
| H2 | Adopt the parent `conversationId` only when **positively identified as ours** — pinned id, workspace-scoped first event, or `workspacePaths` match; with no discriminator, adopt nothing and degrade to idle (never adopt/capture a possibly-foreign id, even one that fires first). | A bare "first event" is unsafe under the global hooks file, where unrelated agy sessions forward to the same socket and one can fire first (§4.2). |
| H3 | Register all five events; `Stop` = finish, the rest = heartbeat + tool-in-flight bracket. | Dense heartbeat (≤7 s gaps) prevents false idle; bracket covers single long tools; belt-and-suspenders around `Stop`. |
| H4 | Shim reads agy payload from **stdin** and always returns `{"decision":"allow"}`. | Matches agy's stdin contract; never gates agy's actions (required for the `PreToolUse` decision hook). |
| H5 | `writeAgyHooksFile` merges/removes only an `ai-whisper-turn-events` named group. | The named-group schema allows non-destructive install/cleanup without clobbering user hooks. |
| H6 | Prefer workspace `.agents/hooks.json`; fall back to global `~/.gemini/config/hooks.json` with the `conversationId` gate. | Workspace scoping is cleanest; global is the guaranteed-load fallback (§11 confirms which). |
| H7 | v1 capture reuses the shared `/copy` path; `transcriptPath` structured capture deferred. | Minimizes divergence from the proven claude flow; transcript read is an enhancement. |
| H8 | `agy` turn-events default **on** (like claude/codex). | It is now a genuine hook-capable provider; `--turn-events off` still disables. |
| H9 | `writeAgyHooksFile` bakes `--workspace-id` into the shim command; the shim routes agy by it, not by payload `cwd`. | Verified agy payloads have no `cwd`; the existing cwd-based router would drop every agy event (§5.1/§5.2). |
| H10 | Prefer workspace `.agents/hooks.json`; under the global file, capture only with a positive discriminator (`workspacePaths` match or pinned id), else disable hook capture and degrade to idle. | The global file funnels all agy processes to one socket; without a positive discriminator no payload field ties an event to our session, so capturing would risk an unrelated turn. The workspace file is structurally race-free. |

## 9. Testing strategy

**Unit**
- `AgyEventReceiver`: a `Stop` payload with `fullyIdle:true` + matching `conversationId` → one turn-event; `fullyIdle:false` → none; mismatched `conversationId` (subagent) → none; `PreInvocation`/`PostInvocation`/`PreToolUse`/`PostToolUse` → heartbeat/activity, not turn-end; `toolCall.name` + `stepIdx` parsed for tool-in-flight.
- `writeAgyHooksFile`: emits the `ai-whisper-turn-events` group with the correct shim command for all five events; merging into a file with a pre-existing user group leaves that group intact; the teardown remover deletes only our group.
- `turn-events-config`: `agy` recognized; default `on`; `off`/`none` disables; startup line shows `agy=ON/off`.
- `turn-event-shim` (agy arm): reads a stdin payload **that contains no `cwd`**, routes it to `${socketDir}/${workspaceId}-agy.sock` using the explicit `--workspace-id` argument (regression: the cwd-based path would drop it), forwards it provider-tagged, and prints `{"decision":"allow"}`.

**Integration**
- Mount runtime with a faked agy hook stream: the parent `conversationId` is captured from the first event; a gated `Stop` triggers capture + handoff exactly once; a subagent `Stop` (different `conversationId`) does **not**; a long quiet gap *with* heartbeat events does not false-idle; a `PreToolUse` with no `PostToolUse` suppresses idle turn-end.
- `mount-turn-event-listener` routes `provider:"agy"` to `AgyEventReceiver`.
- Round-trip: `writeAgyHooksFile` output, parsed back, registers the expected events.
- Global-fallback race: two interleaved agy event streams with **different** `conversationId`s arrive on the same socket. (a) With `workspacePaths` populated, the runtime adopts only the stream matching the mount cwd; the unrelated stream's `Stop` neither sets the parent id nor triggers capture. (b) With `workspacePaths` empty and the **unrelated** stream firing **first**, the runtime adopts no id, captures no `Stop`, and degrades to the idle timer — it never adopts or captures the foreign session (criterion 9).

**Manual smoke (against real `agy`)**
- Mount `agy`; run a task that spawns a subagent; confirm the turn is captured **once**, at true completion (not when the subagent finishes, not mid-pause), and the heartbeat prevented any premature idle capture.
- `--turn-events off` disables the hooks group; capture falls back to idle/`/copy`.
- Confirm the `ai-whisper-turn-events` group is removed from `hooks.json` after the session ends.

## 10. Acceptance criteria

1. A mounted `agy` turn that includes a multi-minute subagent run is captured **exactly once**, on the parent's `Stop`+`fullyIdle:true`, with no premature capture during the subagent (in a supported hooks configuration — workspace-scoped hooks, populated `workspacePaths`, or a pinned conversation id; the discriminator-less global corner degrades to idle per criterion 9).
2. The mounted runtime ignores subagent `Stop` events and the parent's `fullyIdle:false` pause `Stop`.
3. The hook heartbeat prevents the idle timer from firing while `agy` is actively working (including a single tool/command blocking > 30 s, via the tool-in-flight bracket).
4. `--turn-events` defaults `agy` on, shows `agy=ON`, and `off`/`none` disables it (falling back to idle/`/copy`).
5. The `ai-whisper-turn-events` hooks group is installed before launch and removed on teardown; user-authored hook groups are untouched.
6. `getCapabilities().supportsLaunchHooks === true`; `agy ∈ TurnEventProvider`.
7. `pnpm typecheck`, `pnpm build`, and `pnpm test` pass; existing `claude`/`codex`/`ezio` turn-events behavior is unchanged.
8. An `agy` hook payload with no `cwd` is routed to the correct mount socket via the baked `--workspace-id` — no event is dropped for lack of `cwd`.
9. With a global hooks file, an unrelated concurrent `agy` session — **even one that fires its first hook before the mounted session and sends no `workspacePaths`** — never causes this mount to adopt the wrong parent `conversationId` or capture the unrelated session's `Stop`; absent a positive discriminator the mount adopts nothing and degrades to the idle timer (§4.2).

## 11. Open questions (confirm during implementation)

1. **Interactive per-turn `Stop`.** Verified that `Stop`+`fullyIdle:true` fires at turn-end in **print** mode (which then exits). Confirm it also fires after **each turn** in a long-lived **interactive** session (the expected behavior, since `fullyIdle:true`/`terminationReason:NO_TOOL_CALL` denotes "finished responding"). If interactive only fires `Stop` on process exit, fall back to the heartbeat-absence design (idle, kept honest by the heartbeat) for turn-end.
2. **Workspace hooks loading.** `agy -p` ignores cwd (uses `~/.gemini/antigravity-cli/scratch`). Confirm a mounted **interactive** `agy` launched in the workspace cwd loads `.agents/hooks.json` from that cwd. If not, use the global `~/.gemini/config/hooks.json` fallback (§5.3) with the `conversationId` gate.
3. **Hook command shell semantics.** Confirm the `timeout` field's unit/behavior and that a `Stop`/observational hook needs no specific stdout (we return allow regardless). Confirm the `command` is run via a shell so the shim path + args resolve.
4. **Session discriminator strength (global fallback).** Confirm whether interactive `agy` populates `workspacePaths` in hook payloads (empty in print mode — §3). If populated with the workspace path, it is the global-fallback discriminator (§4.2); if not, the global fallback adopts nothing and degrades to the idle timer. Also confirm whether `agy` accepts a caller-supplied conversation id at launch (e.g. `--conversation <uuid>`); if so, pinning it eliminates first-event adoption entirely and becomes the preferred discriminator.

## 12. References

- Base adapter design (superseded turn-events sections): `docs/superpowers/specs/2026-06-27-antigravity-adapter-design.md`.
- Existing turn-event stack (templates): `packages/cli/src/runtime/turn-events-config.ts` (`writeClaudeSettingsFile`, `codexNotifyArgs`, `resolveTurnEvents`, `formatTurnEventsStartupLine`), `packages/cli/src/bin/turn-event-shim.ts`, `packages/cli/src/runtime/event-receiver.ts` (`ClaudeEventReceiver`/`CodexEventReceiver`), `packages/cli/src/runtime/mount-turn-event-listener.ts`, `packages/cli/src/runtime/mount-session-main.ts`, `packages/cli/src/runtime/turn-event.ts`.
- Shared capture (reused): `packages/cli/src/runtime/{clipboard-handback-capture,assistant-turn-capture,capture-handback-text,mounted-turn-owned-relay,relay-orchestrator}.ts`.
- agy hook docs: `antigravity.google/docs/hooks`; local guide `~/.gemini/antigravity-cli/builtin/skills/antigravity_guide/references/cli.md`.
- Empirical probe payloads captured 2026-06-27 (quoted in §3).
