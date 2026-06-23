# Changelog

All notable changes to the `ai-whisper` package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-06-24

### Added

- **Dashboard cards — worktree/cwd line + readable artifact filename**: Wall cards now show the artifact's basename on its own line — the full, copyable filename instead of a gutted middle-ellipsis (`docs/…gn.md`) — plus a new `⌂` line with the run's abbreviated working directory (`$HOME` → `~`, a leading `/private` stripped). Worktree runs (`~/Dev/ai-14all/.worktrees/devel`) are now distinguishable from a main checkout, and runs sharing a directory are told apart by their now-readable filenames. Compact DONE/CANCELED cards drop the redundant `P4/4` token; long paths front-clip to keep the distinctive tail. The Wall allocator's `CARD_HEIGHT` budget moves in lockstep with the new card heights (`{ full: 7, compact: 5 }`) so pagination stays correct.
- **LLM evaluator readiness in `whisper env --json`**: the env report gains an `evaluator: { status, ready }` block reporting whether the evaluator that gates the workflows has credentials, resolved from config alone (`auth.json` / `config.json` / `.env` + process env) without a running daemon. External supervisors (e.g. ai-14all's Plugins panel) can use it to warn that workflows will fail before one is started. `status` is the reason (`ready` / `missing_anthropic_key` / `invalid_config` / `disabled` / `unknown`); `ready` is the boolean rollup.

### Fixed

- **Inspector Timeline duplicate-key flood on resumed workflows**: the Timeline tab keyed its phase rows on `phaseIndex`, which is not unique once an escalated phase is resumed — resume opens a fresh `phase_runs` row at the same index, so `getWorkflowPhaseRuns` returned two rows sharing a key and React emitted a flood of "Encountered two children with the same key" warnings that corrupted the tab. Rows are now keyed on the unique `phaseRunId`; both the escalated attempt and the resumed retry render correctly.

## [0.7.0] - 2026-06-22

### Added

- **deliberation**: new fourth workflow — paired Explorer/Challenger dialectic across Objectives → Approaches → Tradeoffs → Synthesis, producing a committed findings doc; adds the `deliberation-loop` evaluator key that rejects hollow approvals.

## [0.6.1] - 2026-06-21

### Fixed

- **Capture-path hang on a wedged pasteboard** — when the host slept, locked, or
  hit an auto-logoff transition, the macOS pasteboard server (`pboard`) could
  become unresponsive while the mount processes stayed alive, and the
  auto-handback clipboard capture (`pbpaste` + the NSPasteboard `changeCount`
  helper) made unbounded `execFile` calls that never returned — wedging the
  `autoHandbackInFlight` latch and hanging the workflow indefinitely with nothing
  delivered to the relay orchestrator. The capture subprocess calls are now
  bounded by an `execFile` timeout (`AI_WHISPER_CLIPBOARD_IO_TIMEOUT_MS`, default
  `8000`) plus `killSignal`; a `pbpaste` timeout surfaces as a tagged
  `CaptureIoTimeoutError` that becomes a retryable `timed_out` capture status, and
  a lease-acquire failure becomes `lease_unavailable`. Both — together with a new
  relay watchdog (`AI_WHISPER_CAPTURE_WATCHDOG_MS`, default `20000`) bounding the
  whole capture await — are routed into the existing retry ladder, releasing the
  latch and escalating to a visible empty handback at the budget floor instead of
  hanging, and never delivering a partial-PTY fallback on a timeout.

### Changed

- The host-global clipboard capture lease is reconciled with the longer capture
  windows: `DEFAULT_LEASE_TTL_MS` raised `5000` → `25000` and kept ≥ the watchdog
  (derived at the mount as `max(watchdog + 5000, DEFAULT_LEASE_TTL_MS)`);
  per-capture release is now token-scoped on `acquired_at` (a late orphan release
  can no longer clear a newer lease); and the mount-teardown release is pid-scoped
  so it frees only this mount's own lease.

## [0.6.0] - 2026-06-19

> Backfilled retroactively — `0.6.0` shipped to npm without a CHANGELOG entry
> or a `v0.6.0` git tag.

### Added

- **Mounted ezio `/resume` + `/rename`** — a `whisper collab mount ezio` pane can
  now resume a prior conversation and rename the current one. A host-owned
  `runInteractiveOverlay` renders the `/resume` picker, backed by new
  `OverlayIO` / `OverlayRunner` types in `@ai-whisper/shared` and a `resume`
  method on the ai-ezio engine facet.

### Changed

- **Windows guidance** — `whisper collab mount` / `reconnect` now fail fast with
  explicit WSL2 setup guidance instead of an opaque error on native Windows.
- Bundled ai-ezio `v0.2.0-beta.5`.
- Dependency hygiene — overrode `hono` to `4.12.26` and bumped `esbuild`, `tsx`,
  `@anthropic-ai/sdk`, and `postcss` to clear Dependabot alerts.

### Fixed

- Mounted ezio sessions are marked busy at input submit rather than on
  turn-start, closing a window where a fast follow-up could interleave.

## [0.5.9] - 2026-06-14

### Added

- **Mounted ezio slash commands** — a human typing a `/`-command in a
  `whisper collab mount ezio` pane is now handled locally instead of being sent
  to the model (which previously swallowed it and hung the pane). The ai-ezio
  adapter implements a new optional `tryConsumeLocalCommand(line)` method on
  `InteractiveSessionController`; the operator line-input hook in `live-session.ts`
  erases the echoed input and asks the adapter to consume the line before
  submitting a turn, so a command renders on a clean line with no stripe and no
  submission. Supported set: `/help`, `/new` (`/clear`), `/status`, `/skills`,
  `/copy`, `/usage`, `/transcript`, `/compact`. `/quit` and `/exit` are excluded
  (the host owns session lifecycle) and fall through to the standard
  "unknown command" message.
- The mounted `SlashController` (built from the relocated `@ai-ezio/surface`
  package) is wired with mounted capabilities: last assistant-turn content/usage
  tracking for `/copy` and `/usage`, an injectable clipboard, and a minted
  `HAX_TRANSCRIPT` path rendered inline (dump mode, no pager) for `/transcript`.

### Changed

- `AiEzioEngineSession` widened with `start({ transcriptPath })`,
  `transcriptPath`, `newConversation()`, and `status()` (type-only; the real hax
  `Session` already implements them).

### Internal

- Interception is operator-only by construction: `tryConsumeLocalCommand` is
  called from exactly one site (the operator line hook). Relayed/injected turns
  reach `writeUserInput` through `mount-session-main.ts`'s `injectedWrite` and are
  never treated as commands — guarded by `test/injected-input.test.ts`.

Requires `@ai-creed/ai-ezio` ≥ 0.2.0-beta.4 (the `@ai-ezio/surface` slash seams).

## [0.5.8] - 2026-06-13

### Added

- **External integration contracts for supervisors (`whisper env --json`, event
  socket, read contract).** Sanctioned, consumer-agnostic surfaces any external
  supervisor (e.g. ai-14all) can rely on:
  - `whisper env --json` prints exactly one parseable JSON object
    (`engineVersion`, `installPath`, `stateRoot`, `dbSchemaVersion`,
    `protocolVersion`) on stdout and exits 0 — pure-stdout, no DB or network, the
    machine-readable answer to "are you there and can we talk?".
  - A per-collab broker-daemon **event socket** at
    `<stateRoot>/sockets/events-<collabId>.sock` (protocol version `"1"`): a
    `hello` frame on connect, then one newline-delimited JSON wake-up frame per
    broker event (type-level exhaustiveness guard over every `BrokerEventMap`
    name), fanned out to any number of clients with dead-client isolation, and
    created/unlinked with the daemon lifecycle. CLI-originated workflow lifecycle
    events (`whisper workflow start/pause/resume/cancel`, which run on a
    transient runtime) reach the socket reliably via an append-only outbox the
    daemon tails — no transition is lost even when pause and resume land back to
    back.
  - A committed **`docs/state-db-read-contract.md`** documenting the versioned
    read-only surface (access rules, `PRAGMA user_version` gate, exact
    table/column subset, semantics, heartbeat-cadence guarantee, and the socket
    path/protocol), plus a CI contract test that fails if any contract
    table/column or the protocol version drifts without a doc + version bump.

- **Mounted-mode auto-compaction for ezio.** Auto-compaction is now wired into
  mounted ezio sessions through the shared harness driver, carrying cortex
  rehydration forward into the compacted summary (parity with the standalone
  CLI).

### Security

- Patched 6 critical/high Dependabot dependency advisories.

## [0.5.7] - 2026-06-12

### Added

- **Bundled `ai-whisper-plan-execution` skill.** A new bundled skill (shipped in
  the package and installed by `whisper skill install` into the Claude, Codex,
  and ezio skill directories) that structures HOW a workflow implementer
  executes an approved implementation plan: per-task subagent fan-out with
  two-stage review via `superpowers:subagent-driven-development` when the
  harness supports it (with a built-in minimal fallback protocol when it
  doesn't), a model-allocation policy (reviewer tier ≥ implementer tier,
  escalate one tier after a second failed review), an inline escape hatch for
  small or purely mechanical plans, and a mandatory execution-mode disclosure
  in the handback. Harnesses without subagent support (e.g. Codex/ezio as
  implementer) are explicitly unaffected — the skill never blocks or changes
  their handback.

- **SDD plan-execution guidance fragment.** The spec-driven-development
  workflow's plan-execution kickoff and step templates now append
  `PLAN_EXECUTION_SKILL_GUIDANCE`, pointing the implementer at the bundled
  skill while keeping the workflow handback contract authoritative. No other
  workflow phase or template picks up the fragment.

## [0.5.6] - 2026-06-11

### Added

- **Event-driven turn handback for mounted Claude and Codex (`--turn-events`).**
  An opt-in flag that detects turn completion over a local socket — a
  dependency-free turn-event shim plus per-launch provider wiring (Claude
  Stop-hook `--settings`, Codex `notify`) — instead of inferring it from idle
  timing. The relay routes the resulting handback through a relevance gate and a
  turn-fidelity shape gate, with a no-event grace-timeout fallback so a dropped
  event can never halt a workflow. Turn-event diagnostics are persisted (broker
  schema v6) with a retention sweep.

- **Mounted ezio staleness guard.** At ezio mount start, `ai-whisper` now prints a
  dim, non-blocking advisory when the bundled ezio snapshot is older than your
  installed standalone `@ai-creed/ai-ezio` (offline comparison), or when
  `ai-whisper` itself is behind the latest published version (cached ~24h, with a
  bounded 2s network check that runs detached and never blocks mount startup).
  Suppress both with `AI_WHISPER_NO_UPDATE_CHECK=1`.

- **ezio build provenance.** The published bundle now records the exact
  `@ai-creed/ai-ezio` version and git sha it was built against, so the mounted ezio
  version is introspectable at runtime (and drives the staleness guard above).

- **Dashboard Wall cards** now show each collab's start time and its repo-relative
  spec/artifact path, with agent health derived from live sessions.

## [0.5.5] - 2026-06-09

### Fixed

- **`ai-whisper` failed to start with `ERR_MODULE_NOT_FOUND:
  @modelcontextprotocol/sdk` after a clean global install (0.5.4 regression).**
  The mounted ai-ezio MCP host (inlined into the bundle from
  `@ai-ezio/mcp-host`) imports `@modelcontextprotocol/sdk`, which the CLI
  bundle externalizes but did not declare as a runtime dependency — so npm
  never installed it. Added it to the published package's `dependencies`, and
  wired the existing bundle self-containment smoke test (`npm pack` → install
  in a clean dir → `whisper --version`) into both CI and the publish workflow
  so an undeclared externalized dependency can no longer reach the registry.

## [0.5.4] - 2026-06-09

### Fixed

- **Autonomous workflows no longer halt when a mounted agent's `/copy` is slow
  to reach the clipboard.** A read-before-write race in the relay capture
  pipeline could read an empty clipboard before the target agent's `/copy`
  finished writing it, classify the empty clip as a confident "no response",
  and deliver an empty handback that escalated the review gate and halted the
  workflow. The capture layer now re-polls under the held lease while the
  pasteboard change-count has not advanced (the `/copy` is still in flight),
  and the relay retries an empty-clip confident-miss instead of burning its
  one-shot guard — kept distinct from a present-but-rejected clip, a lease
  degrade, or a capture exception, which retain their existing single-shot
  behavior.

## [0.5.3] - 2026-06-08

### Fixed

- **`npm install -g ai-whisper` now succeeds on Node 26.** Bumped
  `better-sqlite3` from `^11.8.1` to `^12.10.0`. `better-sqlite3` 11.x ships no
  prebuilt binary for Node 26, and its native source fails to compile against
  Node 26's V8 (it uses the removed `v8::Object::GetPrototype`,
  `v8::Context::GetIsolate`, and `PropertyCallbackInfo::This` APIs), so a fresh
  global install on Node 26 aborted in `node-gyp`. 12.10.0 ships a Node 26
  (ABI 147) prebuilt binary and declares support for `node: 20.x – 26.x`. No
  API changes in ai-whisper's usage; the full suite (including the SQLite
  migration / capture-lease / state.db paths) is green on Node 26.

## [0.5.2] - 2026-06-08

### Fixed

- **Relay no longer accepts a stale prior-phase clipboard as the current
  gate's handback.** At the capture gate, a `/copy` that returned clipboard
  content left over from an earlier phase could be delivered as the current
  phase's reply (observed as a code-review gate handing back the *previous*
  phase's output). The capture gate now rejects clipboard whose provenance
  does not match the in-flight phase, so a stale read degrades to a re-capture
  instead of a wrong-phase handback. Covered by a RED reproduction test.

### Changed

- **Mounted markdown renderer now lives in `@ai-ezio/surface`.** The
  dependency-light markdown→ANSI renderer that drives the ezio mounted pane was
  extracted out of `@ai-whisper/adapter-ai-ezio` into the shared
  `@ai-ezio/surface` package; the adapter now consumes it rather than carrying
  its own copy. The renderer's previously-inlined npm dependencies (`marked`,
  `marked-terminal`, `string-width`, `cli-table3`) are now externalized by the
  bundle and declared in the published package's `dependencies`, so the
  self-contained artifact keeps installing them normally on a fresh install.
  A repeatable smoke test (`npm pack` + clean install) guards bundle
  self-containment, and an e2e test asserts markdown tables still render as a
  grid in the mounted pane.

## [0.5.1] - 2026-06-06

### Fixed

- **Published artifact is now self-contained — fixes `ERR_MODULE_NOT_FOUND`
  on a fresh install.** 0.5.0 shipped broken: the esbuild bundle inlined only
  `@ai-whisper/*` workspace packages and externalized everything else,
  including the `@ai-ezio/harness` + `@ai-ezio/protocol` `file:` dependencies
  that the ezio adapter imports. Those packages are not published to npm, so a
  fresh global install threw `ERR_MODULE_NOT_FOUND` on `@ai-ezio/harness` for
  *every* command (even `--version`); dev checkouts worked only because their
  `node_modules` carried the `file:` symlinks. The bundle now also inlines the
  pure-TS `@ai-ezio` packages, leaving only the platform-specific hax *binary*
  package (`@ai-ezio/hax-<platform>`) runtime-resolved via
  `createRequire(import.meta.url)` (ESM-safe). Verified against a global
  install with no `@ai-ezio` present.

## [0.5.0] - 2026-06-06

### Added

- **`ezio` as a first-class, mountable agent type.** Alongside `codex` and
  `claude`, ai-whisper now drives `ezio` — a hax-backed, protocol-native agent
  — through a new `@ai-whisper/adapter-ai-ezio` adapter (provider +
  live session). Unlike the PTY-scraped agents, ezio handoff/handback rides the
  structured JSONL protocol: turn completion is an explicit event
  (`onTurnFinished`), so relay handbacks resolve from real turn boundaries
  rather than quiescence heuristics (PTY-style quiescence handback is
  suppressed for protocol-native sessions while auto-accept is preserved).
  Mount it with `whisper collab mount ezio`, and target it in relay directives
  as `@@ezio`.
- **REPL-parity mounted pane for ezio.** A dependency-free markdown→ANSI
  renderer drives a mounted pane that mirrors the standalone ezio REPL: a status
  banner on ready, a usage line, a hax-purple prompt, a magenta stripe echo of
  the operator's submitted input, markdown rendered at turn end, tool calls with
  diffs, and a thinking spinner.
- **Line-buffered operator input for protocol-native sessions.** Operator
  keystrokes are buffered into whole lines before submit; `Ctrl+C` cancels the
  in-flight turn (or clears the current line) and `Ctrl+D` exits the mount.
- **Workflow roles resolve from bound agents.** A shared `AgentType` (exported
  from `@ai-whisper/shared`, with a drift-prevention guard) lets ezio stand in
  for `codex` or `claude` in any workflow role, so ezio-paired SDD / ralph /
  bugfix runs work end to end.
- **`whisper skill install --target ezio`.** The skill installer accepts the
  ezio target and installs the workflow skills into the ezio engine-visible
  directory.

### Changed

- **Workflow-launcher readiness gates are ezio-aware.** The bundled
  `ai-whisper-sdd`, `ai-whisper-ralph`, and `ai-whisper-bugfix` skills now
  accept `ezio` as a valid replacement agent when checking that the required
  roles are bound before a workflow starts.

### Fixed

- **Capture learns each agent's `/copy` change-count signature instead of
  assuming `1`.** Some agents (notably `claude`) emit a multi-write `/copy`,
  which the capture path previously misread as foreign interference and
  delivered as an empty handback — halting long autonomous steps. Capture now
  learns the agent's actual change-count signature, so legitimate multi-write
  copies are accepted.

## [0.4.5] - 2026-06-04

### Added

- **Bundled `ai-whisper-code-review` skill.** A workflow-agnostic guideline for
  reviewing code written by agents: what counts as a blocking finding (with
  file/line or command evidence), how to judge committed tests, how to review
  fix rounds, and how to avoid low-value nit loops. It is installed alongside
  the other workflow skills by `whisper skill install` (into both
  `~/.claude/skills/` and `~/.codex/skills/`). Code-bearing workflow review
  handoffs — SDD `code-review`, complex-bug-fixing `fix-and-verify`, and both
  the Ralph per-item and acceptance reviews — now ask the reviewer to use this
  skill for *how* to inspect code, while the existing `WORKFLOW_REVIEW_PROTOCOL`
  stays authoritative for output shape and evaluator semantics (the guidance is
  injected before the protocol, preserving the verdict-before-`Non-blocking
  risks:` ordering that the evaluator depends on). Non-code reviews (spec, plan,
  diagnosis, post-mortem) are deliberately left unchanged.

## [0.4.4] - 2026-06-03

### Fixed

- **Long autonomous workflow steps no longer halt on a single transient
  empty capture (Mode C).** On heavy `execute`/`fix` steps, the relay's
  auto-handback fired exactly once when the agent pane went idle; if that
  single `/copy` came back empty (clipboard *and* PTY both empty — a
  transient miss), it delivered an empty handback and the orchestrator
  escalated to a permanent halt (`"No handbackText provided"`), even though
  the agent had really completed the work. The auto-handback now retries an
  empty `no_response_captured` capture across later idle ticks — bounded
  (`AI_WHISPER_AUTO_HANDBACK_MAX_ATTEMPTS`, default 3) and spaced
  (`AI_WHISPER_AUTO_HANDBACK_RETRY_MS`, default 10 s) — and only delivers an
  empty handback (the genuine-failure escalate floor) after the budget is
  exhausted. A confidently-rejected reply (`no_response_captured_confidently`,
  i.e. the agent did reply) is delivered immediately, not retried.
- **Concurrent capture overlap guard.** The 1 s idle timer could start a
  second `/copy` for the same handoff while the first capture (up to ~5 s
  with the clipboard poll and lease wait) was still in flight, risking a
  duplicate handback. A synchronous in-flight reservation now serializes
  auto-handback attempts per handoff, released on every exit.

## [0.4.3] - 2026-05-30

### Changed

- **Codex prompt injection now uses bracketed paste instead of a per-character
  drip.** The relay typed the inter-agent handoff prompt into codex one
  character at a time with a 5 ms gap (≈ `len × 5 ms` — ~30 s for a 6 KB prompt,
  the observed sluggishness). It now writes the whole payload in a single
  bracketed-paste sequence (`ESC[200~ … ESC[201~`) and submits with one `\r` on
  a separate beat. Spike- and live-verified against codex v0.135.0, including a
  10 KB multi-line payload: codex ingests it as one pasted block and submits it
  cleanly. Large prompts now inject near-instantly.

### Added

- **Resilient submit-strategy selection.** A detector watches codex's PTY output
  for the bracketed-paste mode toggle (`ESC[?2004h` / `ESC[?2004l`); the codex
  submit strategy resolves to `override ?? (enabled ? bracketed : keystream)`.
  The legacy per-character keystream is retained as the automatic fallback — if
  codex ever stops advertising bracketed paste, selection falls back with no
  code change. `AI_WHISPER_CODEX_SUBMIT_STRATEGY` (`bracketed` | `keystream` |
  `chunk`) pins the strategy manually. Embedded paste end-markers in the payload
  are sanitized so they cannot close the paste early.

## [0.4.2] - 2026-05-30

### Fixed

- **Capture lease no longer throws `database is locked` and halts the
  workflow.** Root cause of the handback-capture failures: `acquireCaptureLease`
  ran as a `DEFERRED` transaction (SELECT, then write the lease row). In WAL
  mode that read→write lock promotion fails with an *immediate* `SQLITE_BUSY`
  ("database is locked") — `busy_timeout` does **not** cover lock promotions —
  the moment any other connection commits after the read snapshot. With multiple
  mount processes sharing `state.db` that race is constant, so the auto-handback
  capture threw, the throw was swallowed into an empty handback, and the workflow
  halted with `"No handbackText provided"`. The lease now acquires with `BEGIN
  IMMEDIATE`, taking the write lock up front so there is no promotion and
  `busy_timeout` applies again. Defense in depth: the capture poll-acquire loop
  now treats a residual lock error as "not acquired" and degrades to PTY-only
  instead of letting it propagate into a swallowed empty handback. The 0.4.1
  diagnostics are what surfaced this — they are retained.
- **Reverted the TEMP 30 s lease poll-acquire window** from 0.4.1 back to the
  4 s default. It never addressed this failure (the poll loop never saw a retry
  signal — the call *threw*); the `IMMEDIATE` transaction is the actual fix.

## [0.4.1] - 2026-05-30

### Fixed

- **Auto-handback no longer halts under lease contention.** When multiple
  mount processes share the host-global clipboard-capture lease (typical
  during cross-project autonomous work), the 4 s acquire window was too
  short to outlast a competing holder — `runLeasedCapture` would degrade
  to PTY-only without ever typing `/copy`, and the orchestrator received
  an empty handback and halted with `"No handbackText provided"` even
  though the reviewer had produced a substantive response. Raises the
  poll-acquire window to 30 s (TEMP marker in `mount-session-main.ts`),
  which absorbs typical contention while remaining invisible end-to-end
  (auto-handback already waits ≥30 s grace + provider idle). Proper fix
  per the capture-reliability hardening design is per-provider capture
  strategies (Phase 2); this is the operator-unblock bridge.

### Added

- **Capture-pipeline diagnostics in the mount stderr.** The auto-handback
  path in `mounted-turn-owned-relay.ts` was silently swallowing every
  failure (lease degrade, null short-circuit, unexpected exception),
  leaving operators with no signal beyond an empty `relay_capture_diagnostics`
  row. Adds `console.warn`s at every silent exit point — entry trace
  (`auto-handback fire: target=… handoff=… turnLen=… turnConf=…`), lease
  degrade (`/copy was NOT executed; PTY fallback only`), `captureHandbackText`
  null return (`likely no session claim`), and previously-swallowed
  exceptions (full error + stack). The first three lines now appear in
  the codex/claude mount terminal so the next halt is immediately
  diagnosable.

## [0.4.0] - 2026-05-28

### Added

- **Status-first dashboard redesign.** `whisper collab dashboard` is rebuilt
  around a single colored glyph per card (`●` running, `⚠` stuck/halted, `✓`
  done, `✖` canceled, `◌` idle / manual relay) so state reads at a glance and
  the screaming `Chain active · ALIVE` text is gone. The Wall is now a grouped
  priority-fill grid with section headers and counts —
  **ACTIVE → IDLE/MANUAL → HALTED → DONE/CANCELED** — laid out in
  most-recently-kicked-off order within each group, with stuck-but-running
  workflows pinned to the front of ACTIVE so escalations stay loud. ACTIVE
  renders full 4-line cards (phase progress bar `▰▱`, per-agent health dots,
  two latest event rows); HALTED / DONE / CANCELED / IDLE collapse to compact
  2-line cards so the operator sees ~12 collabs at a time instead of ~3.
  ACTIVE is never dropped to make room for DONE — lower-priority groups only
  fill the leftover row budget — and the legend lives in the footer. The
  Inspector adopts the same visual language: status glyph in the header,
  terracotta-accented active tab, aligned/colored timeline + cost + evidence
  tables, and workflow-history rows prefixed by the same glyph map.
- **Shared `THEME` + `AGENT_COLOR` palette borrowed from ai-cortex.** A new
  `packages/cli/src/runtime/theme.ts` centralizes all dashboard colors —
  terracotta `#D97757` accent for brand / Inspector active tab,
  palette-green `#7FB069` for card selection (visually distinct from the red
  stuck / canceled border), plus `ok`/`warn`/`err`/`muted` tokens. Per-agent
  tokens render `claude` in signature terracotta and `codex` in palette teal
  `#5FB3C9`, replacing the legacy cyan/magenta in event lines. Card borders
  are now `single` style to match ai-cortex.
- **`whisper collab dashboard --window <duration>` flag.** Operator can widen
  or shrink the eligible-collab activity window from the command line without
  setting `AI_WHISPER_DASHBOARD_WINDOW_MS`. Accepts raw ms or human suffixes
  (`Ns`/`Nm`/`Nh`/`Nd`, decimals fine: `1.5h`) and the literal `all` (or
  `max` / `∞`) for unbounded — useful for inspecting historical or finished
  collabs that fell out of the default 30-minute window. Precedence: flag >
  env > default.

### Changed

- **Workflow type auto-abbreviates on narrow cards.** When a card's pane is
  below the 48-column threshold (e.g. a 2-column grid on an 80-col terminal),
  the dimmed workflow type renders as `bugfix` / `sdd` / `ralph` instead of
  the full `complex-bug-fixing` / `spec-driven-development` / `ralph-loop` to
  keep the header from truncating. Unknown types fall back to the first
  dash-segment, capped at 8 chars. Wide panes and the Inspector always show
  the full name.
- **Elapsed counter freezes on terminal cards.** A `done`/`canceled`/`halted`
  workflow's elapsed value is now computed against its `last_activity_at` end
  time instead of `now`, so the displayed duration reflects the run's actual
  length and stops ticking. Running workflows still advance normally.
- **`CollabSummary.workflowCreatedAt` is now projected.** A single additive
  nullable field on the broker's `CollabSummary` carries the bound workflow's
  `created_at`, so the Wall can sort collabs by kickoff recency. The
  eligible-collab query, finished backfill, and every other type/cast remain
  untouched.

### Fixed

- **`--window all` no longer crashes the dashboard.** `Number.MAX_SAFE_INTEGER`
  underflowed `Date.now() - sinceMs` below epoch and
  `new Date(<negative>).toISOString()` threw `RangeError: Invalid time value`.
  The eligible-collab cutoff is now clamped to ≥ 0, degenerating to
  `1970-01-01` for unbounded windows — exactly the "any collab with activity
  ever" semantic the operator asked for.

## [0.3.0] - 2026-05-28

### Added

- **Operator pause / resume for running workflows.** A healthy, running workflow
  can now be frozen in place and continued later — without the escalation
  semantics of `halt`. This closes a concrete dogfooding failure mode: when a
  glitch in an artifact (spec/plan/source) steered both agents wrong, the
  operator's only options were to let the autonomous loop keep burning rounds on
  the bad artifact or `halt` it (which pollutes the review trail as "the system
  gave up"). New commands:
  - `whisper workflow pause <id>` — freeze a running workflow.
  - `whisper workflow resume <id> [--message "<note>"]` — continue it, optionally
    telling the agents what changed.

  `paused` is a first-class workflow status that **occupies the active-workflow
  slot** (the one-workflow-per-collab invariant and its partial unique index now
  count `running` **and** `paused`), so a second workflow cannot start during a
  pause. Pause freezes **all** delivery/orchestration drivers through a single
  broker chokepoint — a shared `isWorkflowDeliverySuspended` predicate gates the
  pending-orchestration list, claim, auto-accept, and the mount-side request
  injection — so a paused workflow delivers no new turn while a future driver
  inherits the gate by construction. The in-flight turn is never killed: its
  handback is still recorded so the loop can quiesce at a clean boundary, and the
  workspace snapshot baseline is captured **at that boundary** (via
  `git stash create`, scoped to tracked files excluding `.ai-whisper/`), not at
  the pause-command instant — so an in-flight agent's final writes are never
  misattributed to the operator. On resume, the agents receive a one-time notice
  listing the files the operator changed since the workflow quiesced plus the
  optional operator note, prepended exactly once to the next outgoing request
  (whether a handoff already pending accept or the next orchestrator-created
  loop handoff), requiring them to re-read and re-evaluate before continuing.
  Mid-workflow "pause the workflow" guidance — including the Codex-CLI Ctrl+C
  caveat — rides the canonical workflow handoff prompt and the bundled kickoff
  skills. The existing `halted → running` resume path is unchanged.

## [0.2.1] - 2026-05-25

### Fixed

- **Stranded autonomous runs from duplicate active collabs.** A single workspace
  could accumulate more than one `active` collab; a workflow would then bind to
  one collab while the live mounted agents and the running daemon belonged to
  another, so its first handoff was created but never delivered or evaluated —
  the run hung forever at its first step while every operator surface
  (`status`, `inspect`, dashboard) reported "healthy". `ai-whisper` now enforces
  **one active collab per workspace** as an invariant: `mount` transparently
  re-adopts the existing active collab — including re-adopting one whose daemon
  has died, via `recover` — instead of creating a duplicate; a partial unique
  index makes the invariant impossible to violate from any code path; and a
  migration dedups any pre-existing duplicate active collabs (by survivor rules)
  before the index is created, re-run on every `applyMigrations`.
- **Clipboard capture race across concurrent collabs.** The relay captures an
  agent's handback by injecting `/copy` and reading the macOS system clipboard;
  with multiple collabs (or a human ⌘C) active on one host, a collab could read
  *another* collab's response and deliver it into the wrong workflow — worsened
  by the ≥100-char fast-path that trusts any substantial clipboard without a
  similarity check. A new **host-global capture lease** (a singleton row in the
  shared SQLite DB) now serializes every `/copy`→read window cross-process, so
  each read is provably this collab's own output. The lease reclaims stale
  holders (dead pid / TTL), releases on disconnect, and is swept on broker
  startup. `classifyCapture` and its load-bearing ≥100-char fast-path are
  unchanged — the lease removes the race that made the fast-path unsafe.

### Added

- **`changeCount` interference check** for the held capture window: snapshots
  `NSPasteboard.changeCount` before and after `/copy` (via a tiny `swiftc`-built
  native helper) to catch a human ⌘C that the lease cannot serialize. On
  interference it runs a bounded ladder — re-capture under the still-held lease
  → accept only on content similarity/identity (bypassing the ≥100-char
  fast-path) → degrade to the PTY turn text — and never blocks the turn. The
  helper degrades to a skipped check when unavailable (non-macOS or build
  failure), so capture still proceeds on the lease alone.
- `interference_detected` flag on relay capture diagnostics, recording when a
  foreign clipboard write was detected during a held capture window.

## [0.2.0] - 2026-05-25

### Added

- **`complex-bug-fixing` workflow** — a third bundled workflow alongside
  `spec-driven-development` and `ralph-loop`. A fixed three-phase pipeline for a
  reported bug whose root cause is unknown: **diagnosis → fix-and-verify →
  post-mortem**.
  - **Diagnosis** is guarded by a dedicated adversarial review protocol
    (`WORKFLOW_DIAGNOSIS_PROTOCOL`): the implementer must reproduce the bug
    themselves (a committed RED test is strongly preferred — speculation from
    reading code is not a valid reproduction), and the reviewer independently
    reproduces it and keeps the gate shut until both agree the cause is proven
    and the fix is net-safe.
  - **Fix-and-verify** turns the reproduction GREEN and verifies across the
    declared blast radius under an acceptance review that also checks
    test-coverage adequacy.
  - **Post-mortem** records confirmed cause, fix, coverage gaps, residual risks,
    and lessons learned.
  - Diagnosis and post-mortem artifacts live in a gitignored per-run dir
    (`.ai-whisper/bugfix/<workflowId>/`) and are not committed — only the fix and
    the reproduction test land in the repo.
- **`/aiw-bugfix <path>` kickoff skill** — fire-and-forget wrapper that starts
  `complex-bug-fixing` on a bug report after a collab-readiness check, mirroring
  `/aiw-sdd` and `/aiw-ralph`.
- Documentation for the new workflow in `docs/workflows.md` (at-a-glance entry,
  "choosing the workflow", and an "authoring a bug report" guide) and an updated
  bundled-workflows list in `docs/evaluator-configuration.md`.

### Changed

- Engine: added an opt-in `PhaseConfig.anchorCommitBaseOnEntry` flag so a
  review-loop phase can anchor the commit base on entry. This lets the
  fix-and-verify acceptance review resolve `{commitRange}` as `base..HEAD`,
  spanning both the phase-1 RED reproduction test commit and the phase-2 fix
  commits. The change is strictly additive — `spec-driven-development` and
  `ralph-loop` commit-range resolution is unchanged, guarded by regression
  tests.

## [0.1.4] - 2026-05-24

### Added

- `-v` / `--version` flag for the CLI, with a best-effort notice when a newer
  version is available.

### Changed

- Docs: README prerequisites, safety/permissions, and a "what happens if it
  fails" section; the two-agent non-goal codified in the concepts doc.
- Packaging: declare `engines.node >= 22` and add npm keywords.

## [0.1.3] - 2026-05-24

### Fixed

- Dashboard: clear on wall↔inspector switch (no duplicated frames), keep
  recently finished workflows visible (floor of 3), and stop rendering done
  workflows as stuck.

## [0.1.2] - 2026-05-24

### Added

- Caller-becomes-implementer role resolution and the workflows guide.

### Fixed

- Relay-handoff documentation correction.

## [0.1.1] - 2026-05-24

### Fixed

- Ship `README`, `LICENSE`, and `NOTICE` inside the published package. They live
  at the repo root but the package publishes from `packages/cli`, so npm
  previously showed no README and the tarball carried no license; a build step
  now copies them into `packages/cli`.

## [0.1.0] - 2026-05-24

### Added

- Initial public release: terminal-first relay for paired AI coding agents
  (Claude + Codex) driven by structured workflows, with npm metadata
  (description, repository, homepage).

[0.8.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.8.0
[0.7.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.7.0
[0.6.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.6.1
[0.6.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.6.0
[0.5.9]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.9
[0.5.8]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.8
[0.5.7]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.7
[0.5.6]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.6
[0.5.5]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.5
[0.5.4]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.4
[0.5.3]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.3
[0.5.2]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.2
[0.5.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.1
[0.5.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.5.0
[0.4.5]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.4.5
[0.4.4]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.4.4
[0.4.3]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.4.3
[0.4.2]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.4.2
[0.4.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.4.1
[0.4.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.4.0
[0.3.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.3.0
[0.2.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.2.1
[0.2.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.2.0
[0.1.4]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.4
[0.1.3]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.3
[0.1.2]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.2
[0.1.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.1
[0.1.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.0
