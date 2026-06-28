# Cursor Adapter (`cursor` / `agent` CLI) — Design

**Date:** 2026-06-27
**Status:** Approved for planning
**Component:** new `packages/adapter-cursor` + `packages/shared` literals + `packages/cli` runtime/commands

## Goal

Add `cursor` as a fourth supported agent type alongside `claude`, `codex`, and
`ezio`. Cursor ships a terminal CLI (`agent`) that follows the same
subprocess-spawn shape as Claude and Codex: it takes the prompt as a positional
argument, supports a full-autonomy flag, and can emit a single structured JSON
object in headless mode. A user can then `whisper collab mount cursor` and pair
it with any other agent under the existing baton/relay workflow.

## Background

The repo already supports three agents through a common provider contract:

- `CompanionProvider` (`packages/shared/src/provider-contract.ts:31`) — the
  adapter interface: `getIdentity`, `getCapabilities`, `getHealthState`,
  `handleWork`, optional `attachInteractiveSession`.
- Each PTY-backed adapter (`adapter-claude`, `adapter-codex`) exposes a small,
  fixed export surface: a provider factory (`createXxxProvider`), a live
  interactive session (`createXxxLiveSession`), an attached session
  (`createXxxAttachedSession`), and prompt builders (`buildXxxPrompt`,
  `buildXxxFileBackedBrokerPrompt`).
- `adapter-ai-ezio` is protocol-native (no subprocess) and is **not** the model
  for Cursor.
- The CLI selects an adapter purely by `AgentType` in
  `packages/cli/src/runtime/providers.ts` — four switch points
  (`createProviderForTarget`, `createInteractiveSessionForTarget`,
  `getProviderExecArgsForTarget`, `getInteractiveSessionExecArgsForTarget`).

Cursor maps onto the **Claude/Codex PTY-spawn pattern**, not the ezio pattern.

### Cursor CLI facts (verified on this machine, `agent` v2026.06.26-7079533)

The following were confirmed by direct probe, not docs:

- Executable is `agent` (installed at `~/.local/bin/agent`).
- `agent -p --force --output-format json "<prompt>"` prints exactly one JSON
  object on stdout after the agent finishes:
  ```json
  {
    "type": "result",
    "subtype": "success",
    "is_error": false,
    "duration_ms": 7018,
    "duration_api_ms": 7018,
    "result": "<full assistant response text>",
    "session_id": "<uuid>",
    "request_id": "<uuid>",
    "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }
  }
  ```
  Note the `usage` object is present but undocumented; the parser must tolerate
  unknown fields.
- `-p` / `--print` = headless. `--force` (alias `--yolo`) = full autonomy
  (Cursor's equivalent of Claude `--dangerously-skip-permissions` / Codex
  `--dangerously-bypass-approvals-and-sandbox`).
- The prompt is passed as the final **positional** argument. There is no
  `--prompt` flag and no supported stdin prompt path.
- **`--add-dir` is NOT a valid Cursor flag** (`error: unknown option
  '--add-dir'`). With `--force`, the agent already has unrestricted filesystem
  access and can read absolute paths (e.g. the broker's `request.json`) without
  any directory-allowlist flag. Cursor's `--workspace <path>` sets the working
  directory — different semantics; we do not need it.
- On failure the process exits non-zero, writes a human message to stderr, and
  emits **no** JSON on stdout.

### Turn-events: not wired for Cursor (verified)

Claude/Codex feed the relay a per-turn completion event via a provider hook
(Claude `--settings` `Stop` hook on stdin; Codex `-c notify=` as final argv).
Probed against the live `agent` CLI:

| Hook                  | Fires in CLI headless mode? | Notes                                              |
| --------------------- | --------------------------- | -------------------------------------------------- |
| `stop`                | No                          | Type exists, no caller in CLI.                     |
| `afterAgentResponse`  | No                          | Same.                                              |
| `afterShellExecution` | Yes (per shell command)     | Not a turn signal.                                 |
| `sessionEnd`          | Yes (once per session)      | Session-scoped, not per-turn — unusable as a turn event. |

`sessionEnd` looked promising in a `-p` probe only because `-p` collapses
session and turn into one invocation. In a **mounted, long-lived interactive
session** (the context turn-events actually serve, where the same `agent`
process does many baton turns), `sessionEnd` fires a single time at process
teardown — far too late to drive per-turn handbacks. There is currently **no
per-turn hook** that fires in Cursor's CLI.

Therefore Cursor uses the **quiescence-based clipboard `/copy` capture path** —
exactly what Claude/Codex used before turn-events were introduced, and already
the default for any PTY provider with `eventPathEnabled = false` and no
`onTurnFinished` handler. No shim, no `.cursor/hooks.json` injection, no
`CursorEventReceiver`.

**Future extension point:** if Cursor's CLI gains a working per-turn hook (a
firing `stop` / `afterAgentResponse`, or a documented per-turn callback), Cursor
can be promoted to the push-based turn-event path by: adding `cursor` to
`TurnEventProvider`, adding a `CursorEventReceiver`, injecting the hook config at
mount, and flipping the `eventPathEnabled` guard to include `cursor`. The
clipboard fallback would then become its safety net, identical to Claude/Codex
today. This is intentionally left as a clean seam; see "Open question" below.

## Non-goals (this phase)

- **Turn-event / push-based capture for Cursor.** Clipboard `/copy` only this
  phase (see Background). Revisit if/when Cursor ships a per-turn CLI hook.
- **`--add-dir` equivalent.** Not needed; `--force` grants full file access.
- **Cursor model selection / `--model` plumbing.** Cursor's default model is
  used. An override env var can be added later if needed.
- **Codex-style `--output-last-message` file capture.** Cursor has no such flag;
  stdout JSON is the single source.
- **Updating the deprecated `packages/cli/deprecated/**` commands** — legacy,
  out of scope.

## Architecture

### 1. Shared literals

- `packages/shared/src/literals.ts`: add `"cursor"` to `agentTypes` →
  `["codex", "claude", "cursor", "ezio"]`. `AgentType` updates automatically.
- `packages/shared/src/relay-host.ts`: add `"cursor"` to `relayTargets` →
  `["codex", "claude", "cursor", "ezio", "pull"]` so `@cursor` relay directives
  and `InteractiveSessionTarget` recognize it.
- **Lift `extractJsonObjectCandidates`** out of
  `packages/adapter-codex/src/parse-codex-output.ts` (currently a private helper)
  into `@ai-whisper/shared` and re-export it. Both `parse-codex-output` and the
  new `parse-cursor-output` import the single shared copy — avoids
  `adapter-cursor` depending on `adapter-codex` and removes the duplication.
  `parse-codex-output.ts` is refactored to import it (behavior unchanged; its
  existing tests stay green as the regression guard).

### 2. New package `packages/adapter-cursor`

Mirrors `adapter-claude` structure exactly. Files:

- `package.json` — name `@ai-whisper/adapter-cursor`, deps
  `@ai-whisper/shared` (`workspace:*`) + `node-pty` (`^1.1.0`); same scripts
  (`build`, `typecheck`) as the other adapters.
- `tsconfig.json` — extends `../../tsconfig.base.json`, `composite: true`,
  `references: [{ "path": "../shared" }]`.
- `src/cursor-command.ts` — `export type CursorCommandConfig = { executable: string; execArgs: string[] }`.
- `src/cursor-prompt.ts` — `buildCursorPrompt(request)` and
  `buildCursorFileBackedBrokerPrompt(requestFilePath)`. Same JSON-response-schema
  prompt text Claude uses (instruct the model to return
  `{ kind, content, transitionIntent }`).
- `src/parse-cursor-output.ts` — `parseCursorOutput(stdout): ProviderReply`.
  Two-layer parse (see Data flow below). The **inner** `result` parse reuses
  Codex's brace-extraction helper (`extractJsonObjectCandidates`) so a
  fenced/prose-wrapped structured reply still parses; the **outer** envelope uses
  strict `JSON.parse`.
- `src/create-cursor-provider.ts` — `createCursorProvider(config): CompanionProvider`.
  Identity `{ providerId: "cursor-agent-cli", toolFamily: "cursor", providerVersion: "1.0.0" }`.
  Capabilities identical to Claude/Codex (all true except
  `supportsLocalBuffering: false`, `extensions: {}`). `getHealthState` returns
  `"healthy"`. `handleWork` spawns `config.executable` with
  `[...config.execArgs, prompt]`, collects stdout/stderr, and on close:
  non-zero exit → `failure` reply built from stderr; zero exit →
  `parseCursorOutput(stdout)`. Spawn `error` → `failure` reply.
- `src/create-cursor-live-session.ts` — `createCursorLiveSession(input): InteractiveSessionController`.
  Port of `create-claude-live-session.ts`: `node-pty` spawn with TTY sizing +
  resize tracking, pipes provider data to `stdout`, stamps
  `AI_WHISPER_AGENT=cursor` into the child env, exposes
  `start/stop/writeUserInput/resize/sendLocalMessage/onExit/onProviderOutput`.
- `src/create-cursor-attached-session.ts` — passthrough stub identical to
  `create-claude-attached-session.ts`.
- `src/index.ts` — exports:
  ```ts
  export const adapterCursorPackage = { name: "@ai-whisper/adapter-cursor" } as const;
  export { createCursorProvider } from "./create-cursor-provider.js";
  export { createCursorLiveSession } from "./create-cursor-live-session.js";
  export { createCursorAttachedSession } from "./create-cursor-attached-session.js";
  export { buildCursorFileBackedBrokerPrompt, buildCursorPrompt } from "./cursor-prompt.js";
  export type { CursorCommandConfig } from "./cursor-command.js";
  ```

### 3. CLI provider routing (`packages/cli/src/runtime/providers.ts`)

Add the import and a `cursor` branch in all four functions. Because Cursor needs
**no** `--add-dir`, its exec args do not reference `tempRoot`:

- `getInteractiveSessionExecArgsForTarget("cursor")` → `["--force"]`
- `getProviderExecArgsForTarget("cursor")` → `["-p", "--force", "--output-format", "json"]`
- `createProviderForTarget("cursor")` → `createCursorProvider({ executable: process.env.AI_WHISPER_CURSOR_CMD ?? "agent", execArgs: getProviderExecArgsForTarget("cursor") })`
- `createInteractiveSessionForTarget("cursor")` → `createCursorLiveSession({ config: { executable: process.env.AI_WHISPER_CURSOR_CMD ?? "agent", execArgs }, cwd, stdout, replyTimeoutMs? })`

The `turnEvents` parameter is ignored for cursor (no hook flags).

### 4. Turn-event type exclusion

- `packages/cli/src/runtime/turn-event.ts`: change
  `TurnEventProvider = Exclude<AgentType, "ezio">` to
  `Exclude<AgentType, "ezio" | "cursor">` so cursor is not treated as a
  push-event provider. (Keeps `claude | codex`.)
- `packages/cli/src/runtime/turn-events-config.ts`: add `"cursor"` to
  `RECOGNIZED_TURN_EVENTS_TOKENS` so a user listing it in `--turn-events` is not
  flagged as a typo. **No** change to `TurnEventsEnablement`, `resolveTurnEvents`,
  or `formatTurnEventsStartupLine` — cursor is never event-enabled.
- The `eventPathEnabled` and listener guards in
  `packages/cli/src/runtime/mount-session-main.ts` already gate on
  `target === "claude" || target === "codex"`; cursor falls through to `false`
  with no edit, so it gets `suppressQuiescenceHandback = false` and the clipboard
  capture path automatically.

### 5. CLI surface (`packages/cli/src/create-cli.ts`)

Update help text and choice lists to include `cursor`:

- Mount `--target` description and the mount/reconnect `<agent>` argument help
  (lines ~160, ~232, ~247).
- `--implementer` / `--reviewer` descriptions (lines ~415–416).
- Skill-install `.choices([...])` (line ~557) → add `"cursor"`.
- The `--turn-events` description stays `claude,codex` (cursor isn't an event
  provider).

### 6. Workflow partner inference (`packages/cli/src/commands/workflow/start.ts`)

`otherAgent()` keeps the literal `claude<->codex` flip; `cursor` (like `ezio`)
has no hardcoded partner and is resolved from `boundAgents`. When neither flag
nor a second bound agent is present for a cursor role, it throws the same
explicit "pass --implementer and --reviewer explicitly" error. No new flip
branch is added — the existing fallthrough already produces that behavior.

### 7. Skill install (`packages/cli/src/commands/skill/install.ts`)

- **Fix the `homeForTarget` ternary at :46.** It currently reads
  `target === "claude" ? ".claude" : ".codex"`, so *any* non-claude target
  (including cursor) silently routes into `~/.codex/skills`. Add an explicit
  `cursor` branch → `~/.cursor/skills` (parallels `~/.claude`, `~/.codex`). This
  is a real branch addition, not just a list edit.
- Add `"cursor"` to `VALID_TARGETS`.
- Update the invalid-target error message and the `"all"` expansion to include
  `cursor`.

### 8. Wiring / build

- `packages/cli/package.json`: add `"@ai-whisper/adapter-cursor": "workspace:*"`
  to `devDependencies`.
- Root `tsconfig.json`: add `{ "path": "packages/adapter-cursor" }` to
  `references`.
- `pnpm-workspace.yaml`: no change (already globs `packages/*`).

### 9. Docs

- `README.md`: add Cursor to the supported-agents prose, prerequisites (install
  `agent` CLI, signed in), and a mount example.

## Data flow

### One-shot work (`handleWork` → broker)

1. Build prompt: `context.artifactHandle` present →
   `buildCursorFileBackedBrokerPrompt(requestFilePath)`; else
   `buildCursorPrompt(request)`.
2. `spawn("agent", ["-p", "--force", "--output-format", "json", <prompt>])`.
3. On non-zero exit → `{ kind: "failure", content: "Cursor exited with code N: <stderr>", transitionIntent: "failed" }`.
4. On zero exit → `parseCursorOutput(stdout)`:
   1. `JSON.parse(stdout)` → envelope. Parse failure → `failure` reply.
   2. If `is_error === true` or `subtype !== "success"` → `failure` reply.
   3. Take `envelope.result` (string). Run `extractJsonObjectCandidates(result)`
      (shared helper) and try `mockProviderReplySchema.parse(JSON.parse(c))` for
      each candidate; return the first that validates (the model followed the
      JSON-reply instruction, even if it fenced or prefaced it with prose).
   4. If no candidate validates, wrap raw text:
      `{ kind: "answer", content: result, transitionIntent: null }`.

### Mounted interactive session

`createCursorLiveSession` spawns `agent --force` in a PTY, mirrors the terminal
size, pipes Cursor's TUI to the operator's stdout, and forwards operator
keystrokes. Turn completion is detected by the existing quiescence/idle detector,
which arms the clipboard `/copy` capture to lift the handback text — no provider
hook involved.

## Error handling

- **`agent` not on PATH** — spawn `error` event → `failure` reply naming the
  executable; `AI_WHISPER_CURSOR_CMD` is the override escape hatch.
- **Non-zero exit / empty stdout** — `failure` reply carrying trimmed stderr.
- **Malformed or non-success envelope** — `failure` reply (`"Cursor output was
  not a successful result"` / `"... did not contain JSON"`).
- **Envelope OK but `result` is plain prose** — wrapped as an `answer` reply so a
  non-JSON-compliant model response still flows through rather than hard-failing.
- **Clipboard capture interference / timeout** — handled by the existing
  capture-lease + changeCount machinery shared with Claude/Codex; no
  cursor-specific handling.

## Testing

Follow TDD; add focused unit tests mirroring the Claude/Codex suites.

- `parse-cursor-output`: success envelope w/ inner JSON reply; success envelope
  w/ **fenced/prose-wrapped** structured `result` (brace-extraction recovers it);
  success envelope w/ plain-text `result` (answer-wrap fallback); `is_error:
  true`; `subtype !== "success"`; malformed envelope; empty stdout; envelope with
  extra `usage` field (must not break parsing).
- `extractJsonObjectCandidates` shared move: the existing
  `parse-codex-output` suite is the regression guard that the lift-and-refactor
  preserved behavior; no new bespoke copy of those cases needed.
- `cursor-prompt`: `buildCursorPrompt` and `buildCursorFileBackedBrokerPrompt`
  produce the expected JSON-schema instruction text.
- `create-cursor-provider`: injected fake-spawn — verify argv
  (`-p --force --output-format json <prompt>`), zero-exit → parsed reply,
  non-zero exit → failure with stderr, spawn-error → failure.
- `runtime-provider-launch-config` (extend existing test): assert
  `getProviderExecArgsForTarget("cursor")` and
  `getInteractiveSessionExecArgsForTarget("cursor")` exactly, and that neither
  includes `--add-dir`/`tempRoot`.
- `turn-events-config` (extend): `"cursor"` is a recognized token (no typo
  warning) yet never appears in `TurnEventsEnablement`.
- `skill install`: `cursor` is valid and routes to `~/.cursor/skills`; `all`
  includes cursor.
- Regression: existing claude/codex/ezio routing and turn-event tests stay green.

## Edge cases

- Cursor emits `usage` (and possibly other future fields) in the envelope —
  parser ignores unknown keys.
- A model that ignores the JSON-reply instruction returns prose — the answer-wrap
  fallback keeps the workflow moving.
- `agent` shares the very generic command name `agent`; `AI_WHISPER_CURSOR_CMD`
  overrides it if a different binary shadows it on PATH.
- Cursor's `sessionEnd` payload exposes `workspace_roots` / `session_id` /
  `transcript_path` — recorded here as the data a future turn-event integration
  would consume, but unused this phase.

## Open question (deferred, not blocking)

If Cursor later ships a per-turn CLI hook, decide whether to promote Cursor to
the push-based turn-event path (adding a `CursorEventReceiver` reading the
transcript JSONL) or keep clipboard capture. Tracked as the future extension
point in Background; no action this phase.

## Sequencing (3 PRs)

- **PR1 — shared + adapter (self-contained, nothing routes to it yet):**
  `packages/shared/src/literals.ts`, `packages/shared/src/relay-host.ts`, lift
  `extractJsonObjectCandidates` into `@ai-whisper/shared` (+ refactor
  `parse-codex-output.ts` to import it), new `packages/adapter-cursor/**` (9
  files) with unit tests for `parse-cursor-output` and `cursor-prompt`. TDD:
  tests first.
- **PR2 — CLI routing + turn-event exclusion + surface:**
  `packages/cli/src/runtime/providers.ts` (4 branches),
  `packages/cli/src/runtime/turn-event.ts` (exclude cursor),
  `packages/cli/src/runtime/turn-events-config.ts` (recognized token only),
  `packages/cli/src/create-cli.ts` (help text + choices),
  `packages/cli/package.json` (adapter-cursor dep), root `tsconfig.json` (project
  reference). Extends `runtime-provider-launch-config` and `turn-events-config`
  tests.
- **PR3 — skill install + workflow + docs:**
  `packages/cli/src/commands/skill/install.ts` (homeForTarget ternary fix +
  target/error/all edits), `packages/cli/src/commands/workflow/start.ts`
  (partner-inference verification), `README.md`.

## Touch list (file-by-file)

1. `packages/shared/src/literals.ts` — `agentTypes` += `"cursor"`. *(PR1)*
2. `packages/shared/src/relay-host.ts` — `relayTargets` += `"cursor"`. *(PR1)*
3. `packages/shared/**` — lift `extractJsonObjectCandidates` into shared +
   re-export; refactor `adapter-codex/src/parse-codex-output.ts` to import it.
   *(PR1)*
4. `packages/adapter-cursor/**` — new package (9 files). *(PR1)*
5. `packages/cli/src/runtime/providers.ts` — import + 4 `cursor` branches. *(PR2)*
6. `packages/cli/src/runtime/turn-event.ts` — exclude `"cursor"` from
   `TurnEventProvider`. *(PR2)*
7. `packages/cli/src/runtime/turn-events-config.ts` — recognized-token only.
   *(PR2)*
8. `packages/cli/src/create-cli.ts` — help text + skill-install choices. *(PR2)*
9. `packages/cli/package.json` — adapter-cursor devDependency. *(PR2)*
10. Root `tsconfig.json` — project reference. *(PR2)*
11. `packages/cli/src/commands/skill/install.ts` — homeForTarget ternary fix
    (:46) + target + `~/.cursor/skills` + error/all edits. *(PR3)*
12. `packages/cli/src/commands/workflow/start.ts` — partner inference (no flip
    branch; verify error path). *(PR3)*
13. `README.md` — supported agents, prerequisites, mount example. *(PR3)*
