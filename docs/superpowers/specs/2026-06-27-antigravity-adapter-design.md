# Antigravity Adapter — Full Parity Design

**Date:** 2026-06-27
**Status:** Approved design, ready for planning
**Context:** ai-whisper — adding Google Antigravity (`agy`) as a first-class fourth agent with full feature parity alongside `claude`, `codex`, and `ezio`, in a single implementation pass.

> **Verification note.** Cross-package claims were checked against the code on `master` as of 2026-06-27. The external `agy` CLI claims were verified against a real install (`agy` v1.0.13 at `~/.local/bin/agy`, Gemini-based, config root `~/.gemini`) by inspecting `--help`, the `plugin`/`install` subcommands, and the on-disk `~/.gemini` tree. The `/copy` slash command was confirmed available in the agy TUI by the user. Remaining assumptions are called out explicitly.

## 1. Summary

Add `packages/adapter-antigravity` and wire `agy` through every layer that currently knows about `claude`/`codex`/`ezio`, so `agy` can act as a complete agent: mountable, workflow implementer or reviewer, relay participant, reconnectable, and a skill-install target. `agy` is a **byte/PTY provider** in the same family as `claude` and `codex` — it runs as an interactive terminal program driven through `node-pty`, the broker injects requests via PTY stdin, and turn output is captured by the existing shared mount runtime. It is **not** protocol-native like `ezio`.

The one feature `agy` cannot reach this pass is **turn-end event hooks**: `claude` wires a `Stop` hook (`--settings`), `codex` wires `notify=`, and `agy` exposes no equivalent. `agy` is therefore recognized in the turn-events config but defaults **off**, relying on the shared idle-timer + `/copy` + PTY-scrape capture path (the same fallback `claude`/`codex` use when hooks are absent). A clean extension seam is left for when Antigravity adds hook support upstream.

## 2. Goals & Non-goals

**Goals**
- New `packages/adapter-antigravity` package implementing the full `CompanionProvider` + `InteractiveSessionController` contracts.
- `whisper collab mount agy`, `whisper collab tell --target agy`, and `whisper collab reconnect agy` all work.
- `whisper workflow start --implementer agy` / `--reviewer agy` route work to `agy` as either role.
- `whisper skill install --target agy` (and `--target all`) install skills into agy's config dir.
- `agy` is accepted by every provider-token validation surface and surfaced in the operator dashboard.
- Turn capture works for `agy` via the shared runtime with no new capture code.
- Full test parity and documentation updates.

**Non-goals**
- Turn-end event hook wiring for `agy` (no agy mechanism exists; recognized-but-off with a seam — §9).
- **Auto-launch via `whisper collab start`.** `agy` is **manual-mount parity** (mount/tell/reconnect/workflow/skill-install), the same level `ezio` has. The `collab start` launcher is hardcoded to spawn a `codex`+`claude` pair (`launcher.ts` `LaunchResult`, and `session_attachment.agent_type` is constrained to `codex|claude` in terminals mode); `ezio` is not auto-launchable either. Generalizing the launcher is a separate effort (§16).
- Attached/passthrough sessions for `agy` — the `adopt-session` flow is deprecated and intentionally **not** carried forward for the new provider (§16).
- Cold conversation resume on reconnect via `agy --continue`/`--conversation <ID>` — noted as a future enhancement (§11).
- `agy`-specific prompt tuning beyond the standard JSON envelope.

## 3. Verified agy CLI capabilities

From `agy --help`, `agy plugin --help`, `agy install --help`, and the `~/.gemini` tree (v1.0.13):

| Capability | agy mechanism | Maps to |
|---|---|---|
| Autonomy (skip approvals) | `--dangerously-skip-permissions` | Same flag as `claude` (note: `codex` differs — `--dangerously-bypass-approvals-and-sandbox`). |
| Workspace scoping | `--add-dir <dir>` (repeatable) | Same as `claude`/`codex`. |
| Non-interactive single shot | `--print` / `-p` / `--prompt` (+ `--print-timeout`, default 5m) | Provider `handleWork` (broker mode). |
| Interactive initial prompt | `--prompt-interactive` / `-i` | Optional alternative to plain spawn + PTY inject for mounted sessions. |
| Conversation resume | `--continue` / `-c`, `--conversation <ID>` | Future cold-resume on reconnect (out of scope). |
| Model / project | `--model`, `--project`, `--new-project` | Not required for parity. |
| Sandbox | `--sandbox` | Not used. |
| Config root | `~/.gemini` | Gemini-CLI lineage. |
| Skills directory | `~/.gemini/config/skills/` (confirmed populated) | `skill install` target. |
| Plugins | `agy plugin import|install|enable|disable|validate` | Richer than needed; not used for parity (skill install uses the skills dir directly). |
| Turn-end hook | **none found** (no `--settings`, no `notify=`, no `settings.json` in `~/.gemini`) | Forces turn-events off (§9). |
| `/copy` slash command | **confirmed available** (user-verified in TUI) | Primary turn-capture mechanism (§8). |

## 4. Decisions

| # | Decision | Notes |
|---|----------|-------|
| D1 | Agent token / executable is `agy`. | Matches the binary and the short-token convention (`claude`/`codex`/`ezio`). Executable defaults to `agy`, configurable via the same per-provider mechanism `claude`/`codex` use. |
| D2 | Autonomy via `["--dangerously-skip-permissions"]` + `["--add-dir", <root>]`. | Verified identical to `claude`'s flag (not `codex`'s). |
| D3 | Prompt injection: PTY stdin write + `\r` for mounted sessions; `--print` for broker `handleWork`. | Mounted path mirrors `claude`'s simple submit strategy. |
| D4 | Turn capture: idle-timer → `/copy` (primary, verified) → PTY-scrape fallback. | Inherited entirely from the shared mount runtime (§8). |
| D5 | Turn-events: recognize `agy` token, default **off**, **no** receiver/shim/listener branch wired; exclude `agy` from `TurnEventProvider`. | No agy hook exists; leave a seam, not dead code (§9). |
| D6 | Identity: `providerId="google-antigravity-cli"`, `toolFamily="antigravity"`, `providerVersion="1.0.0"`, set via `createProviderIdentity(...)`. | `providerVersion` is required by `providerIdentitySchema`. |
| D7 | Env stamp `AI_WHISPER_AGENT=agy` in the child PTY env. | Consistent with `claude`→`"claude"`, `codex`→`"codex"`. |
| D8 | Package name `@ai-whisper/adapter-antigravity`. | Follows the `adapter-*` convention. |
| D9 | Reconnect parity via the generic re-mount path (`createMountSessionRuntime`). | No agy-specific flags needed; only display-name generalization (§11). |
| D10 | Skill install target `~/.gemini/config/skills/`. | Verified real dir; mirrors the per-provider home routing. |
| D11 | Generalize the operator dashboard to show actually-bound agents. | Fixes the hardcoded `["codex","claude"]`; also surfaces `ezio` (§13). |
| D12 | Drop the attached/passthrough (`adopt-session`) flow for `agy`. | Deprecated; not carried forward. |
| D13 | Full test parity (adapter unit + live-session + submit-strategy + prompt/parser). | No event-receiver/turn-event tests (no hook) (§14). |
| D14 | Update all docs and agent-enumeration prose. | `README.md`, `packages/cli/README.md`, CLI help strings. |

## 5. Architecture

`agy` is a **byte/PTY provider**, slotting into the same machinery as `claude`/`codex`:

- **Adapter package** owns provider-specific concerns only: command config, provider factory (`handleWork`), live-session factory (PTY spawn + I/O relay), prompt builders, output parser.
- **Shared contracts** (`packages/shared`) are reused unchanged in *shape*; three *enumerations* must learn the `agy` token (§6.1).
- **Mount runtime + capture** (`packages/cli/src/runtime`) are shared and provider-agnostic. `agy` inherits turn capture, idle handling, relay handoff, reconnect re-mount, and orchestrator evaluation. The adapter writes **no** capture code; it only feeds PTY output via the standard output callback.

This deliberately differs from the `ezio` model (protocol-native: `loadSessionHosts` + `DelegatedToolRegistry`, `supportsNormalization: false`, no PTY env stamp). `agy`, like `claude`/`codex`, is normalized terminal bytes.

The existing multi-agent infrastructure already generalizes past two agents: partner inference (`resolveRoleBindings` → `otherAgent`, `packages/cli/src/commands/workflow/start.ts`) and relay sender resolution (`packages/cli/src/commands/collab/tell.ts`) both prefer the actually-bound agent set (`boundAgents`) and fall back to the `claude↔codex` literal only for the original pair. `agy` inherits this behavior with **no changes** — it works fully when its partner is explicit or bound, and errors clearly (like `ezio`) if named alone. The only genuinely two-agent-locked surface is the dashboard (§13).

## 6. What ships

### 6.1 `packages/shared` (enum/type additions)

| File | Change |
|---|---|
| `src/literals.ts` | Add `"agy"` to `agentTypes` (currently `["codex","claude","ezio"]`). This auto-extends the derived `AgentType` union — the real validation surface for agent tokens. |
| `src/relay-host.ts` | Add `"agy"` to `relayTargets` (currently `["codex","claude","ezio","pull"]`). |

The reused contracts need no edits: `CompanionProvider`, `InteractiveSessionController`, `ProviderWorkRequest`, `ProviderReply`, `ProviderCapabilities`, `ProviderIdentity` (`packages/shared/src/{provider-contract,interactive-session,provider-capabilities,provider-identity}.ts`).

### 6.2 `packages/adapter-antigravity` (new package)

Mirrors `adapter-claude`'s file layout. **No** attached-session file (D12).

| File | Purpose | Claude analogue |
|---|---|---|
| `antigravity-command.ts` | `AntigravityCommandConfig` type: `{ executable: string; execArgs: string[] }`. | `claude-command.ts` |
| `create-antigravity-provider.ts` | `createAntigravityProvider(config)` → `CompanionProvider`. Implements the **full** interface: `getIdentity()` (via `createProviderIdentity`, D6), `getCapabilities()` (§10), `getHealthState()`, `handleWork(request, context?)` (uses `--print`), optional `attachInteractiveSession?(session)`. | `create-claude-provider.ts` |
| `create-antigravity-live-session.ts` | `createAntigravityLiveSession(input)` → `InteractiveSessionController`. Spawns `agy` via `spawn()` from `node-pty` using `buildAntigravityPtySpawnOptions(...)` (stamps `AI_WHISPER_AGENT=agy`, D7). Binds stdout, resize, stdin relay. | `create-claude-live-session.ts` + `buildClaudePtySpawnOptions` |
| `antigravity-prompt.ts` | Broker prompt builders: `buildAntigravityPrompt(request)`, `buildAntigravityFileBackedBrokerPrompt(requestFilePath)`. | `claude-prompt.ts` |
| `antigravity-live-session-prompt.ts` | Mounted interactive prompt: `buildAntigravityInteractiveBrokerPrompt(requestFilePath, workItemId)`. | `claude-live-session-prompt.ts` |
| `parse-antigravity-output.ts` | `parseAntigravityOutput(stdout)` → `ProviderReply` (JSON-envelope extraction). | `parse-claude-output.ts` |
| `index.ts` | Barrel exports. | `index.ts` |
| `package.json`, `tsconfig.json` | Package manifests (deps: `@ai-whisper/shared` workspace, `node-pty`). | adapter-claude manifests |

### 6.3 `packages/cli` runtime

| File | Change |
|---|---|
| `src/runtime/turn-event.ts` | Change `TurnEventProvider = Exclude<AgentType,"ezio">` to `Exclude<AgentType,"ezio"|"agy">` so the hook stack (shim/receiver/listener) does not branch for `agy` (no hook). |
| `src/runtime/providers.ts` | Import the antigravity factories. Add `agy` arms to: `getInteractiveSessionExecArgsForTarget` (autonomy + `--add-dir`), `getProviderExecArgsForTarget` (`--print` + autonomy + `--add-dir`), `createProviderForTarget`, and `createInteractiveSessionForTarget`. |
| `src/runtime/provider-submit-strategy.ts` | Add an `agy` branch using the `claude`-style strategy: write text, brief delay, write `\r`. |
| `src/runtime/relay-directive.ts` | **Relay gate (see note below).** Add `agy` to the `relayPattern` regex (L7), the `unsupportedRelayPrefix` regex (L8), and the `getRelayDirectiveError` text (L43). `agy` requires a non-empty instruction (same rule as codex/claude). |
| `src/runtime/live-session.ts` | **Relay prefix preview.** Add `"@@agy"` to the `isRelayPrefix` detector array (L81); it currently lists only `["@@codex","@@claude","@@pull"]` — also add the missing `"@@ezio"` while here. |
| `src/runtime/turn-events-config.ts` | Add `"agy"` to `RECOGNIZED_TURN_EVENTS_TOKENS` (so it is not flagged as a typo). Extend `TurnEventsEnablement` to `{ claude; codex; agy }`. In `resolveTurnEvents`, **pin `agy` to `false` unconditionally** — never `set.has("agy")`, since no hook can run (§9). `formatTurnEventsStartupLine` shows `agy=off`. No `writeAgySettingsFile`/`agyNotifyArgs`. |
| `src/runtime/operator-inspect.ts` | Generalize `roles` (hardcoded `["codex","claude"]`) to the actually-bound agents so `agy` (and `ezio`) appear (§13). |
| `src/runtime/relay-view-state.ts` | **Typecheck-breaker (§13).** `AGENT_DISPLAY_RANK: Record<AgentType, number>` (L222) is exhaustive over `AgentType`; add an `agy` key (e.g. `agy: 0`) or `pnpm typecheck` fails. |
| `src/runtime/theme.ts` | **Typecheck-breaker (§13).** Add an `agy` color to `AGENT_COLOR` (L12). It is indexed as `AGENT_COLOR[ah.agent]` with an `AgentType` at `dashboard-view.tsx:281`, so a missing key breaks typecheck and leaves agy uncolored. |

**Relay gate note.** Adding `agy` to `relayTargets` (§6.1) is necessary but **not sufficient** to make `@@agy ...` work in a mounted session. The active parser is the `relayPattern` regex in `relay-directive.ts` — the regex (not the shared enum) decides which `@@<target>` prefixes are accepted. The `live-session.ts` prefix detector only drives the inline preview. Both must learn `agy`; otherwise `whisper collab tell --target agy` works while typed `@@agy` relay does not.

The turn-event hook stack (`src/bin/turn-event-shim.ts`, `src/runtime/event-receiver.ts`, `src/runtime/mount-turn-event-listener.ts`, and the event-path branches in `src/runtime/mount-session-main.ts`) is **intentionally not modified** — excluding `agy` from `TurnEventProvider` keeps these correct without dead branches (§9).

### 6.4 `packages/cli` commands & surface

| File | Change |
|---|---|
| `src/bin/companion-agent.ts` | **Cosmetic.** Validation is dynamic — L29 checks `agentTypes.includes(agentArg)` — so `agy` is accepted automatically once it is in `agentTypes` (§6.1), and provider/session construction routes through `createProviderForTarget`/`createInteractiveSessionForTarget` (§6.3). Only the stale error string "codex, claude, or ezio" (L31) needs `agy` added. |
| `src/commands/skill/install.ts` | Add an `agy` arm to `homeForTarget` returning `~/.gemini/config/skills`. Add `"agy"` to `VALID_TARGETS`, to the `"all"` expansion array, and to the invalid-target error message (L60). |
| `src/commands/collab/reconnect.ts` | Replace the hardcoded display-name ternaries (`input.target === "codex" ? "Codex" : "Claude"`, lines ~98/108) with a shared display-name helper covering all agents (also fixes `ezio` mislabeling). |
| `src/commands/collab/mount.ts`, `src/runtime/broker-connect.ts` | Update hardcoded agent enumerations in user-facing text: the `reconnect <codex\|claude>` hint (mount.ts:303, broker-connect.ts:33 — also missing `ezio`) and the turn-events validation error "expected claude, codex, off, or none" (mount.ts:158) to include `agy`. |
| `src/create-cli.ts` | Add `"agy"` to the one `.choices()` (`skill install --target`, ~L557) and to the help strings: `collab tell --target` (~L160), `collab mount <agent>` (~L247), `collab mount --turn-events` (~L256), `workflow start --implementer` (~L415), `workflow start --reviewer` (~L416), `collab reconnect <agent>` (~L232). |

### 6.5 Build / workspace wiring

| File | Change |
|---|---|
| `packages/cli/package.json` | Add `"@ai-whisper/adapter-antigravity": "workspace:*"` to **`devDependencies`** — matching the existing workspace adapters (L50-53). They are dev deps because the CLI bundles them at build (`scripts/bundle.mjs`); they are not runtime `dependencies`. |
| `tsconfig.json` (root) | Add the path alias `"@ai-whisper/adapter-antigravity": ["./packages/adapter-antigravity/src/index.ts"]`. |
| `pnpm-workspace.yaml` | No change — `packages/*` auto-discovers the new package. |

### 6.6 Docs

`README.md`, `packages/cli/README.md`, and any agent-enumeration prose updated to list `agy` alongside `claude`/`codex`/`ezio`.

## 7. PTY spawn details

```
executable: <AntigravityCommandConfig.executable>   // "agy"
execArgs:   <AntigravityCommandConfig.execArgs>      // ["--dangerously-skip-permissions", "--add-dir", <root>]

buildAntigravityPtySpawnOptions({ cols, rows, cwd, baseEnv? }) ->
  name: "xterm-256color"
  cols, rows, cwd
  env:  { ...(baseEnv ?? process.env) string entries, AI_WHISPER_AGENT: "agy" }   // D7
```

Live session follows `create-claude-live-session.ts`: build options → `spawn()` (node-pty) → wire `onData`/`onExit`/resize.

## 8. Turn capture path (inherited)

Capture lives entirely in `packages/cli/src/runtime` and is shared; the adapter contributes none. `agy` feeds PTY bytes via the standard output callback; `/copy` is its primary capture mechanism (verified available).

```
agy prints turn → assistant-turn-capture accumulates (extractLatestAssistantTurn)
        ▼
idle timer (AI_WHISPER_IDLE_THRESHOLD_MS, default 30_000ms) fires → finish turn (PTY text frozen)
        ▼
submit "/copy" → clipboard read (captureClipboardHandback → pbpaste on darwin,
                 AI_WHISPER_CLIPBOARD_IO_TIMEOUT_MS default 8_000ms)
   + PTY-text fallback when the clipboard lease degrades
   under watchdog (AI_WHISPER_CAPTURE_WATCHDOG_MS default 20_000ms)
        ▼
classifyCapture(...) →
   CaptureHandbackStatus: "captured" | "degraded_pty_only" | "timed_out" | "lease_unavailable"
   CaptureClassification: "ok" | "no_response_captured_confidently" | "no_response_captured"
        ▼
broker.control.handoffBackRelay({ ..., captureStatus }) → relay-orchestrator evaluator → verdict
```

Shared files: `mount-session-main.ts` (idle timer, `/copy` trigger, constants), `clipboard-handback-capture.ts`, `assistant-turn-capture.ts`, `capture-handback-text.ts`, `mounted-turn-owned-relay.ts`, `relay-orchestrator.ts`.

## 9. Turn-events handling

`agy` exposes no turn-end hook mechanism (verified — §3). Following the chosen approach (recognize + default off + capture fallback):

- **Recognize:** `agy` is added to `RECOGNIZED_TURN_EVENTS_TOKENS` so it is not flagged as a typo, and `TurnEventsEnablement` carries an `agy` field.
- **Always off — explicitly too:** `resolveTurnEvents` pins `agy` to `false` in every branch (unset default, allow-list, and `off`/`none`). It must **not** be implemented as `agy: set.has("agy")`, or `--turn-events agy` would report `agy=ON` with no hook to run. When the resolved token set explicitly contains `agy`, emit a startup warning that agy turn-events are unsupported (no hook) and remain off. The startup line renders `agy=off`.
- **Do not wire a hook:** `agy` is excluded from `TurnEventProvider`, so the shim/receiver/listener and the `mount-session-main` event-path branches do not handle it. No `AgyEventReceiver`, no `writeAgySettingsFile`/`agyNotifyArgs`.
- **Capture:** `agy` always uses the non-event path (§8).
- **Seam:** when Antigravity adds a hook upstream, enabling turn-events for `agy` is a localized change — add it back to `TurnEventProvider`, add an `AgyEventReceiver` parsing agy's payload, wire the receiver in `mount-turn-event-listener.ts` and the event-path branches in `mount-session-main.ts`, and flip the `resolveTurnEvents` default.

## 10. Capabilities

`getCapabilities()` returns a `ProviderCapabilities` (all six fields required):

```typescript
{
  supportsDirectPackets: true,
  supportsNormalization: true,    // byte/PTY provider, like claude/codex (ezio is false)
  supportsRelayInterception: true,
  supportsLocalBuffering: false,
  supportsLaunchHooks: false,     // no turn-end hook (D5); claude/codex set true
  extensions: {},
}
```

## 11. Reconnect

`whisper collab reconnect agy` works through the existing generic path: `runCollabReconnect` (`packages/cli/src/commands/collab/reconnect.ts`) re-mounts the target on the current TTY via `createMountSessionRuntime` after verifying an inactive bound session. It already accepts any `AgentType`, so `agy` participates with **no** new flags. The only change is generalizing the hardcoded display-name ternaries (§6.4).

Future enhancement (out of scope): use `agy --continue` / `--conversation <ID>` to cold-resume the prior conversation on reconnect rather than re-mounting fresh.

## 12. Skill install

`whisper skill install --target agy` installs into `~/.gemini/config/skills/` (verified real, already populated). `homeForTarget` gains an `agy` arm; `VALID_TARGETS`, the `"all"` expansion, and the error message gain `"agy"`. (agy's `plugin import` system is richer but unnecessary — skill install drops `SKILL.md` directories into the skills dir, matching the other providers.)

## 13. Dashboard generalization & exhaustive `AgentType` maps

Two distinct concerns here; the second is a hard build gate.

**Dashboard roles.** `operator-inspect.ts` builds `roles` from a hardcoded `["codex","claude"]`, so neither `ezio` nor `agy` appears. Generalize it to render the agents actually bound to the collab. This gives `agy` true dashboard parity and incidentally surfaces `ezio` (a pre-existing gap).

**Exhaustive `AgentType` maps (typecheck).** Growing the `AgentType` union breaks any value typed exhaustively over it. A repo sweep found exactly two such sites, both of which must gain an `agy` entry or `pnpm typecheck` fails:
- `relay-view-state.ts:222` — `AGENT_DISPLAY_RANK: Record<AgentType, number>` (add `agy`, e.g. rank `0`).
- `theme.ts:12` — `AGENT_COLOR` (add an `agy` color). It is indexed with an `AgentType` at `dashboard-view.tsx:281` (`AGENT_COLOR[ah.agent]`), so a missing key both fails typecheck and renders agy uncolored.

`pnpm typecheck` passing is part of acceptance (§15) precisely to catch this class.

## 14. Testing strategy

**Unit**
- `parse-antigravity-output.ts`: JSON envelope → `ProviderReply`; surrounding noise stripped; malformed → `failure`.
- `antigravity-prompt.ts` / `antigravity-live-session-prompt.ts`: builders emit the expected schema instruction and broker markers; file-backed builder references the request file.
- `create-antigravity-provider.ts`: `getIdentity()` returns D6 values and passes `providerIdentitySchema`; `getCapabilities()` matches §10; `getHealthState()` valid.
- `buildAntigravityPtySpawnOptions`: stamps `AI_WHISPER_AGENT=agy`, copies only string env entries.
- `turn-events-config.ts`: `agy` recognized (not a typo); `resolveTurnEvents` returns `agy:false` for unset, `--turn-events agy`, and `off`; `--turn-events agy` warns "unsupported"; startup line renders `agy=off`.
- `provider-submit-strategy` (agy): writes text then `\r`.
- `relay-directive.ts`: `parseRelayDirective("@@agy do x")` parses with `target:"agy"`; `@@agy` with empty instruction → `null`; `@@agy[bad]` → unsupported-syntax error mentioning `agy`.

**Integration**
- `createProviderForTarget("agy")` / `createInteractiveSessionForTarget("agy")` dispatch to the antigravity factories with correct exec args.
- `companion-agent` bin accepts `agy` as a target (does not error) and constructs the antigravity provider.
- Mount runtime with a faked `agy` PTY: prompt injection writes text + `\r`; a printed turn is captured via the idle/`/copy` path and yields a populated `captureStatus`.
- A typed `@@agy <instruction>` line in a mounted session is detected as a relay prefix (preview) and parsed into a relay directive targeting `agy`.
- `agentTypes`/`relayTargets` accept `"agy"`; a relay handoff targeting `agy` validates.
- `resolveRoleBindings` with `agy` explicit/bound resolves correctly; `agy` alone with no partner errors clearly.
- `skill install --target agy` resolves `~/.gemini/config/skills`; `--target all` includes `agy`.
- `operator-inspect` renders an `agy` role when `agy` is bound; `AGENT_DISPLAY_RANK`/`AGENT_COLOR` resolve for `agy`.

*No event-receiver / turn-event-shim / turn-event smoke tests for `agy`* — no hook is wired (§9).

**Manual smoke (against real `agy`)**
- `whisper collab mount agy`: launches with `--dangerously-skip-permissions` accepted; relayed request appears; a completed turn is captured via `/copy` and handed back.
- `whisper workflow start --implementer agy --reviewer claude`: full implement→review loop.
- `whisper collab reconnect agy`: re-mounts on the current TTY.

## 15. Acceptance criteria

1. `whisper collab mount agy` launches an interactive `agy` PTY session with `AI_WHISPER_AGENT=agy` and accepts a broker-injected request via stdin + `\r`.
2. A completed `agy` turn is captured through the shared idle/`/copy`/PTY-fallback path and reaches the orchestrator with a populated `captureStatus`, with no capture code in the adapter.
3. `whisper workflow start --implementer agy` and `--reviewer agy` route work to `agy` as either role; partner inference behaves like `ezio`.
4. `whisper collab tell --target agy` and `whisper collab reconnect agy` work, and a typed `@@agy <instruction>` relay directive is parsed and routed in a mounted session.
5. `whisper skill install --target agy` installs into `~/.gemini/config/skills`; `--target all` includes `agy`. The `companion-agent` bin accepts `agy`.
6. `agy` is accepted at every provider-token validation surface (`agentTypes`, `relayTargets`, the `relay-directive` regex, the `skill install` `.choices()`, help strings) and rejected nowhere it should be valid.
7. The operator dashboard surfaces a bound `agy` (and `ezio`) role.
8. `--turn-events` recognizes `agy` and keeps it `off` in every branch — including explicit `--turn-events agy`, which warns "unsupported"; the startup line shows `agy=off`; no turn-event hook is wired.
9. **`pnpm typecheck` and `pnpm build` both pass** (catches the exhaustive `AgentType` maps — §13) and the full test suite is green.
10. Existing `claude`/`codex`/`ezio` behavior is unchanged (regression-free); the new adapter package builds and is depended on by the CLI.

## 16. Scope boundary

**In scope:** the `adapter-antigravity` package; `packages/shared` enum/type additions; CLI runtime dispatch, submit strategy, relay-directive parsing (`@@agy`), turn-events recognition, dashboard generalization, and the exhaustive `AgentType` maps (typecheck); `companion-agent` bin; skill install; reconnect display-name fix; command-surface and build wiring; full tests; docs.

**Out of scope:** auto-launch via `whisper collab start` (launcher is a hardcoded `codex`+`claude` pair; agy is manual-mount parity like ezio — §2); turn-end event hook wiring (no agy mechanism — §9); attached/passthrough (`adopt-session`) flow for `agy` (deprecated, dropped — D12); cold conversation resume on reconnect (§11); `agy`-specific prompt tuning.

## 17. Open questions

1. **Executable override env var** — confirm the exact per-provider mechanism `claude`/`codex` use to override their binary path and apply the same for `agy` (naming detail, settled at implementation).
2. **Turn-end hooks upstream** — track whether Antigravity adds a hook/notify mechanism that would let us enable turn-events for `agy` via the §9 seam.

## 18. References

- Adapter template: `packages/adapter-claude/src/` (byte/PTY); contrast `packages/adapter-ai-ezio/src/` (protocol-native).
- Shared contracts/enums: `packages/shared/src/{provider-contract,provider-capabilities,provider-identity,interactive-session,literals,relay-host}.ts`.
- CLI runtime: `packages/cli/src/runtime/{providers,provider-submit-strategy,turn-events-config,turn-event,operator-inspect,mount-session-main,relay-directive,live-session,relay-view-state,theme,broker-connect}.ts` and `dashboard-view.tsx`.
- CLI commands/surface: `packages/cli/src/create-cli.ts`; `packages/cli/src/bin/companion-agent.ts`; `packages/cli/src/commands/{skill/install,collab/reconnect,collab/tell,collab/mount,workflow/start}.ts`.
- Auto-launch (out of scope, codex+claude-only): `packages/cli/src/runtime/launcher.ts`, `packages/cli/src/commands/collab/start.ts`.
- Turn capture (inherited): `packages/cli/src/runtime/{clipboard-handback-capture,assistant-turn-capture,capture-handback-text,mounted-turn-owned-relay,relay-orchestrator}.ts`.
- Turn-event hook stack (not modified): `packages/cli/src/bin/turn-event-shim.ts`, `packages/cli/src/runtime/{event-receiver,mount-turn-event-listener}.ts`.
- Build: `packages/cli/package.json`, root `tsconfig.json`, `pnpm-workspace.yaml`.
