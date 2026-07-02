# Mount Duo Art — v1 Implementation Plan

Source spec: `~/.ai-pref-nsync/local-docs/ai-whisper/specs/mount-duo-art-v1.md` (rev 2026-07-02b, approved)
Repo mirror of spec: `docs/superpowers/specs/2026-07-02-mount-duo-art-design.md`
Status: plan, not yet implemented
Date: 2026-07-02
Revision: 2026-07-02c — review pass 1 fixes: 14 distinct asset files with drift guard, persisted `duo_roll` table for latent-slot claims, owner-liveness definition covering all staleness modes. Review pass 2 fix: opt-out release re-timed to `completeAttachClaim` (the real bound state — `issueAttachClaim` only creates `pending_attach`); claim stays pre-spawn for the banner, justified as additive/self-healing

Five phases, each independently shippable, each following TDD (tests written first against the seam, then implementation until green). Definition of done for every phase: `pnpm test` green, full `tsc` typecheck green, no changes outside the phase's listed files.

## Ground-truth integration map (verified against current source)

| Seam | Location |
|---|---|
| Pre-spawn chrome anchor (turn-events startup line) | `packages/cli/src/commands/collab/mount.ts:150` |
| Collab resolution before spawn | `resolveOrCreate()` result available at `mount.ts:295`; `runtime.start()` at `mount.ts:386` |
| Flag precedence precedent | `resolveTurnEvents()` in `packages/cli/src/runtime/turn-events-config.ts:53` (flag > env > default ON) |
| Mount CLI options declaration | `packages/cli/src/create-cli.ts:272-307` (`.command("mount")`) |
| Broker DB open + migrations | `packages/broker/src/storage/open-database.ts`, `apply-migrations.ts` (`CURRENT_SCHEMA_VERSION = 6` at `:25`, base tables in `initMigrationSql`) |
| Repository pattern | free functions `(db, ...)` under `packages/broker/src/storage/repositories/`, exported via `packages/broker/src/index.ts` (e.g. `collab-repository.ts`, `workflow-repository.ts`) |
| Broker "RPC" | in-process control service over shared sqlite: `packages/broker/src/control/create-control-service.ts:178`; CLI calls `broker.control.<method>` (example: `issueAttachClaim` handler at `:853-917`, client at `mount.ts:364`) |
| Binding liveness probe | `defaultIsPidAlive` at `mount.ts:39-47` (injectable seam `isPidAlive` at `:114`); attachment pid rows via `broker.control.listSessionAttachments` (`mount.ts:342-349`) |
| Adapter env stamping | env built inside each adapter's `buildXPtySpawnOptions` from `baseEnv ?? process.env`: claude `create-claude-live-session.ts:74`, codex `create-codex-live-session.ts:74`, agy `create-antigravity-live-session.ts:69`; ezio spawns no agent PTY (protocol-native) |
| Injected input channel | `injectedWrite` path in `packages/cli/src/runtime/mount-session-main.ts:391` |
| Handoff prompt builder | `buildRelayHandoffInput` at `mount-session-main.ts:65` |
| Relay chrome | `` sendNow(`[ai-whisper] Handed turn to ${directive.target}.`) `` at `mount-session-main.ts:468` (raw `AgentType`, no display helper) |
| Dashboard labels | raw `agentType` strings in `packages/cli/src/runtime/relay-view-state.ts:125` (route), `:382` (turn row), `:388-402` (health dots); fed from `dashboard-state.ts:659-689`; `agentDisplayName` (`runtime/agent-display.ts:10`) is NOT currently used by the dashboard |
| Asset bundling precedent | skills: copied by `packages/cli/scripts/copy-skills.mjs` in the `build` script (`package.json:64`), shipped via `"files"` allowlist (`package.json:67-73`); runtime path resolution via `import.meta.url` with fallback (`runtime/cli-package-info.ts:14-19`) |
| Bundled kickoff skills | `packages/cli/skills/{ai-whisper-sdd,ai-whisper-ralph,ai-whisper-bugfix}/SKILL.md` |
| Tests | vitest, centralized under root `test/**/*.test.ts(x)`; workspace aliased to `src`; sqlite repo test precedent `test/workflow-repository.test.ts` (`createBrokerRuntime({ sqlitePath: ":memory:" })`); PTY env test precedent `test/pty-agent-env.test.ts` (calls option builders with fake `baseEnv`, no spawn) |

---

## Phase 1 — Duo registry + art assets (pure, no I/O beyond asset reads)

Goal: the complete duo data model and the 14 bundled art files, with roll logic, fully testable without a broker or terminal.

New files:

- `packages/cli/src/duo/duo-table.ts`
  - Types: `DuoRole = "reviewer" | "implementer"` (cosmetic flavor only, per spec), `DuoCharacter = { id: string; displayName: string; summonName: string; punchline: string; artFile: string }`, `Duo = { id: string; characters: [DuoCharacter, DuoCharacter] }`.
  - `DUOS: readonly Duo[]` — the seven approved duos, fourteen characters, punchlines exactly as tabled in the spec. `summonName` is the shout-case form used in the banner ("HEISENBERG", "BATMAN"); `displayName` the prose form ("Walter White", "Batman").
  - Lookup helpers: `getDuo(duoId)`, `getCharacter(duoId, characterId)`.
- `packages/cli/src/duo/roll-duo.ts`
  - `rollDuo(rng: () => number): RolledDuo` where `RolledDuo = { duoId: string; slots: [{ characterId, role }, { characterId, role }] }`. Picks a duo uniformly, assigns reviewer/implementer flavor randomly between the two characters. `rng` injected for deterministic tests (default `Math.random`).
- `packages/cli/src/duo/art-assets.ts`
  - `loadCharacterArt(artFile: string): string` — resolves `assets/duos/<artFile>` relative to the package root via `new URL("../../assets/duos/", import.meta.url)` with a dist-layout fallback, mirroring `cli-package-info.ts:14-19`. Strips trailing whitespace/padding lines; returns the art block verbatim otherwise (artist signatures preserved).
  - `maxDisplayWidth(art: string): number` — per-line width via `[...line].length` (code points, NOT bytes — braille chars are 3 UTF-8 bytes; this was a verified footgun during curation).
- `packages/cli/assets/duos/*.txt` — **14 distinct files, one per character** (spec art contract: "one per character", phase 1: "14 asset files"), contents taken from the approved gallery (`scratchpad/duo-art-gallery.txt`, reviewed in-terminal 2026-07-02): sherlock, watson, frankenstein, igor, quixote, sancho, c3po, r2d2, batman, robin, rocket, groot, walter, jesse. Quixote and Sancho each get their own file whose content is the shared windmill scene — two byte-identical files, kept in sync by a dedicated drift-guard test (below), NOT one shared file referenced twice. Artist signatures (`jgs`, `bug`, `jsm`, `jrei`, `ejm/a:f/mic`, `snd`) stay embedded.
- `packages/cli/scripts/copy-assets.mjs` — clone of `copy-skills.mjs` copying `assets` → `dist/assets`; chain into the `build` script in `packages/cli/package.json` and add `"assets"` to the `"files"` allowlist (skills precedent: shipped both top-level and under `dist/`).

Tests first (root `test/duo-table.test.ts`, `test/duo-art-assets.test.ts`):

1. Exactly 7 duos, 14 characters, all `id`/`displayName` unique, every character has a non-empty punchline matching the spec table.
2. All 14 `artFile` values are distinct (no sharing — one file per character), all 14 files exist on disk under `assets/duos/`, and every one loads successfully via `loadCharacterArt`.
3. Drift guard: `quixote.txt` and `sancho.txt` are byte-identical (both intentionally carry the shared windmill scene; the test pins them together so an edit to one cannot silently diverge the other).
4. Every art asset has `maxDisplayWidth ≤ 80` and no trailing U+2800 braille-blank padding.
5. `rollDuo` with a stubbed rng is deterministic; over the rng seed space it can produce every duo; the two slots always carry complementary roles (one reviewer, one implementer) and two distinct characters of the same duo.

Files touched: all new, plus `packages/cli/package.json` (build script + files array). No existing runtime code changes.

## Phase 2 — Assignment persistence (broker sqlite, per-agent claim rows)

Goal: durable claim rows keyed by `(collabId, agentType)` with roll-once/claim-per-mount, release, and inherit-if-dead semantics, exposed on the control service.

Schema (in `packages/broker/src/storage/apply-migrations.ts`):

- Add to `initMigrationSql` — TWO tables:

  ```sql
  CREATE TABLE IF NOT EXISTS duo_roll (
    collab_id TEXT PRIMARY KEY,
    duo_id TEXT NOT NULL,
    slot0_character_id TEXT NOT NULL,
    slot0_character_name TEXT NOT NULL,
    slot0_role TEXT NOT NULL,
    slot1_character_id TEXT NOT NULL,
    slot1_character_name TEXT NOT NULL,
    slot1_role TEXT NOT NULL,
    rolled_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS duo_assignment (
    collab_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    duo_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    character_name TEXT NOT NULL,
    role TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (collab_id, agent_type)
  );
  ```

- Bump `CURRENT_SCHEMA_VERSION` 6 → 7 (per the guidance comment at `apply-migrations.ts:5-9`; the body is idempotent so re-running on existing DBs is safe).
- **Why two tables:** `duo_roll` persists the FULL rolled pair — both slots with character ids, names, and roles — at first claim. This is what makes the second claim implementable without the broker importing the CLI duo table: the latent slot's complete identity is already in the database, so the broker hands it out verbatim. `duo_assignment` stores only CLAIMED per-agent rows; every display/persona surface keys exclusively on `duo_assignment`, so the opt-out guarantee (no row → vendor name) is unchanged. `releaseDuoCharacter` deletes claim rows only — the roll row persists for the collab's lifetime so a freed slot can be re-claimed with the same identity.
- `character_name` is denormalized into both tables so the broker/dashboard never needs the CLI-side duo table to render a name. `duo_id`/`character_id` remain the canonical reference for art/punchline lookups CLI-side.
- Add both tables to `deleteCollabCascade` (`collab-repository.ts:144`) so duo rows die with the collab.

New repository `packages/broker/src/storage/repositories/duo-assignment-repository.ts` (free-function pattern, zod-validated rows like `collab-repository.ts`):

- Roll: `insertDuoRoll(db, roll)`, `getDuoRoll(db, collabId)`.
- Assignments: `upsertDuoAssignment(db, row)`, `getDuoAssignment(db, collabId, agentType)`, `listDuoAssignments(db, collabId)`, `deleteDuoAssignment(db, collabId, agentType)`.
- Export from `packages/broker/src/index.ts`.

Control-service methods (in `create-control-service.ts`, following the `issueAttachClaim` transactional pattern at `:853-917`):

- `claimDuoCharacter({ collabId, agentType, proposedRoll, isPidAlive? })` — all inside `db.transaction(...).immediate()`:
  1. Existing `duo_assignment` row for `(collabId, agentType)` → return it, `outcome: "existing"` (idempotent remount).
  2. No `duo_roll` row for the collab → persist `proposedRoll` (rolled CLI-side, where the duo table lives — the broker package must not import the CLI duo module) as the collab's `duo_roll` row, then claim slot 0 for the caller, `outcome: "claimed"`. Slot 1 stays latent inside `duo_roll` until another duo-enabled mount claims it.
  3. `duo_roll` exists and one of its two slots is unclaimed (no `duo_assignment` row carries that slot's `character_id`) → claim that slot verbatim from the roll — character id, name, AND role all read from `duo_roll`, no CLI-side lookup needed. `outcome: "claimed"`. The caller's own `proposedRoll` is ignored.
  4. Both slots claimed → owner-liveness check (definition below) for each owner. If an owner is dead → delete its row, insert the claimant with that slot's character/role, `outcome: "inherited"`. If both live → `outcome: "fallback"`, no row written (vendor-name mount, no trios — spec decision 5).
  - Returns `{ outcome, assignment | null, teammate: assignment | null }`.
- **Owner liveness** (spec third+ mount rule: dead = "stale/degraded attachment"): an owner is LIVE only if a `session_attachment` row of kind `mounted` exists for its agentType with a non-null pid whose probe succeeds (`isPidAlive` injectable, defaulting to a `process.kill(pid, 0)` probe equivalent to `mount.ts:39-47`). A missing attachment row, a null pid, or a failed probe each independently count as DEAD — matching the reclaim semantics already used at `mount.ts:342-349`.
- `releaseDuoCharacter({ collabId, agentType })` — delete the row if present (used by `--no-duo` mounts to clear stale rows; spec enablement section).
- `listDuoAssignmentsForCollab(collabId)` — read-through for dashboard/runtime.

Tests first (`test/duo-assignment-repository.test.ts`, `test/duo-claim-control.test.ts`, following `test/workflow-repository.test.ts` — `createBrokerRuntime({ sqlitePath: ":memory:" })`, seed a `collab` row):

1. Repository CRUD round-trip for both tables + PK conflict behavior (`duo_assignment` upsert replaces; second `insertDuoRoll` for the same collab rejects or is ignored — one roll per collab).
2. First claim persists the FULL proposed roll into `duo_roll` (both slots, ids + names + roles) and claims slot 0.
3. Second claim (other agentType) receives the latent slot exactly as persisted in `duo_roll` — character id, name, and complementary role — with its own different `proposedRoll` demonstrably ignored.
4. Same agentType re-claim is idempotent (`existing`, same row).
5. Third agent, both owners live → `fallback`, no row.
6. Third agent inherits when an owner is dead by EACH staleness mode, as three separate cases: (a) attachment pid probe fails (stub `isPidAlive` → false), (b) no `session_attachment` row exists for the owner at all, (c) attachment row present but pid null. In each: old row gone, character transferred, `outcome: "inherited"`.
7. `releaseDuoCharacter` deletes the claim row but leaves `duo_roll` intact; a subsequent `claimDuoCharacter` for another agentType re-claims the freed slot with the identical character identity from the roll.
8. `deleteCollabCascade` removes the collab's `duo_roll` and `duo_assignment` rows.
9. Migration test: fresh `:memory:` DB has both tables; `PRAGMA user_version` = 7.

Files touched: `apply-migrations.ts`, new repository, `collab-repository.ts` (cascade), `packages/broker/src/index.ts`, `create-control-service.ts` (+ its types), tests. CLI untouched.

## Phase 3 — Banner wiring + `--no-duo` flag

Goal: the visible feature — enablement resolution, claim/release call, art banner with summon line and punchline, pause, scrollback-push — inserted into the mount path.

New files:

- `packages/cli/src/runtime/duo-config.ts` — `resolveDuoEnabled(flag?: boolean): boolean` mirroring `resolveTurnEvents` precedence: explicit `flag === false` (from `--no-duo`) wins; else `AI_WHISPER_DUO` env (`off`/`0`/`false`/`none` → disabled); else default ON.
- `packages/cli/src/duo/banner.ts` — pure renderer:
  - `renderDuoBanner({ summonName, role, punchline, art, columns }): string` — layout per spec: `⚡ Summoning <SUMMONNAME> as <role>...`, blank line, art block, blank line, indented quoted punchline; terminated with `\x1b[0m` (spec decision 7).
  - Width guard (spec decision 6): if `columns < maxDisplayWidth(art)`, return the name-only banner (summon line + punchline, no art), still reset-terminated.
  - `renderVendorBanner({ agentType })` — the fallback line for `outcome: "fallback"` mounts (plain `Summoning <Vendor> ...` via `agentDisplayName`).

Changes to existing files:

- `packages/cli/src/create-cli.ts` (mount command, `:272-307`): add `.option("--no-duo", "disable duo character banner/persona for this mount")`. Commander negation yields `opts.duo === false`; thread as `duoFlag: opts.duo` into `runCollabMount`.
- `packages/cli/src/commands/collab/mount.ts`:
  - New input fields: `duoFlag?: boolean`, plus test seams `sleep?: (ms) => Promise<void>` and `bannerOut?: NodeJS.WriteStream` (defaults: real timer, `process.stdout`).
  - **Timing — claim and release deliberately do NOT share one hook**, because `issueAttachClaim` (`mount.ts:364`) only creates a `pending_attach` binding (`create-control-service.ts:898-910`); the binding actually flips to bound in `completeAttachClaim`, which runs after `liveSession.start()` inside the runtime (`mount-session-main.ts:511-516`). The banner must print before the spawn, but the spec's "releases on binding" wording refers to the real bound state — so:
    - **Claim (duo-enabled): pre-spawn**, after `issueAttachClaim` returns and before `runtime.start()` — the banner needs the assignment. `resolveDuoEnabled(duoFlag)` enabled → roll CLI-side (`rollDuo`), call `claimDuoCharacter`, render: `claimed`/`existing`/`inherited` → full art banner; `fallback` → vendor banner. Claiming early is safe because it is additive and self-healing: it writes only the claimant's own row and can displace only a DEAD owner, so if this mount subsequently fails to spawn/complete, it leaves a row whose owner is dead — exactly the state the inherit-if-dead rule already reclaims, and a remount of the same agentType resolves to `existing`. No live mount's state is ever destroyed by a failed claimer.
    - **Release (`--no-duo`): post-binding**, NOT in the pre-spawn window. Thread `duoDisabled` into `createMountSessionRuntime`; immediately after `completeAttachClaim` succeeds (`mount-session-main.ts:511-516`) call `releaseDuoCharacter` via a short-lived DB handle (the `recordMountedSession` pattern, `mount.ts:56`). Release is destructive with no self-heal (row gone, display flips to vendor), so it must fire only once this mount is genuinely bound: a `--no-duo` invocation that dies during provider spawn or claim completion — not just before the attach claim — leaves the prior assignment row untouched. Pre-spawn, a disabled mount simply skips all banner/persona/claim work.
    - Write banner to `bannerOut`, await `sleep(3000)` (dramatic pause, spec decision 3), then write `bannerOut.rows ?? 40` newlines (scrollback-push; uniform across providers — harmless for claude, required for codex).
  - Keep the claim result in scope — Phase 4 threads it into the runtime.

Tests first (`test/duo-config.test.ts`, `test/duo-banner.test.ts`, extend the existing mount tests file(s)):

1. Precedence: flag false beats env; env `off` disables; unset → enabled; garbage env values → enabled (default) — mirror `resolveTurnEvents` tests.
2. Banner renders summon line, art, punchline, ends with `\x1b[0m`; narrow `columns` drops art but keeps lines + reset; vendor banner format.
3. Mount integration (fake stdout + stub sleep + `:memory:` broker): enabled mount writes art + `rows` newlines and creates a claim row; `--no-duo` mount writes no banner, no row, and deletes a pre-seeded row; `fallback` outcome writes the vendor banner; disabled via env behaves like the flag.
4. Opt-out timing: the release fires only after `completeAttachClaim` succeeds (real binding). Three cases: (a) a `--no-duo` mount that fails before the attach claim (live-owner conflict, resolver failure) leaves a pre-seeded assignment row untouched; (b) a `--no-duo` mount whose provider spawn or claim completion fails AFTER `issueAttachClaim` (pending_attach never completes) ALSO leaves the row untouched; (c) a `--no-duo` mount that binds successfully deletes it. Exercise via the runtime test harness with a failing `liveSession.start()` stub for case (b).
5. Claim timing: a duo-enabled mount that fails before `issueAttachClaim` creates no claim row; one that claims and then fails to spawn leaves a dead-owner row that a subsequent duo-enabled mount inherits (covered by the Phase 2 inheritance cases) and that a remount of the same agentType resolves as `existing`.

Files touched: 2 new modules + `create-cli.ts` + `mount.ts` + `mount-session-main.ts` (post-binding release hook + `duoDisabled` runtime input) + tests.

## Phase 4 — Persona carry

Goal: the mounted agent knows its character; the identity survives handoffs and context compaction. Channels per spec (and `mem-2026-05-27`: prompt fragment primary + kickoff-skill section, never a new standalone skill).

Changes:

1. **Env stamps** (`mount.ts`): when the mount is duo-enabled and holds an assignment, set `process.env.AI_WHISPER_CHARACTER = <displayName>` and `process.env.AI_WHISPER_CHARACTER_ROLE = <role>` before `runtime.start()`. All PTY adapters build child env from `baseEnv ?? process.env` (claude `:74`, codex `:74`, agy `:69`), so the stamp flows into every child spawn with zero adapter edits. ezio spawns no agent PTY (protocol-native) — for ezio the env channel is inert and persona rides channels 2–3 only. Do NOT stamp on `--no-duo` or `fallback` mounts.
2. **Session-start persona brief** (`mount-session-main.ts`): extend `createMountSessionRuntime` input with optional `duo?: { character: string; role: DuoRole; teammate: { agentType: AgentType; character: string | null } | null }` (threaded from the Phase 3 claim result). After the session binds, inject a ≤3-line brief via the existing `injectedWrite` path (`:391`): character, role, teammate (teammate named by character only if the teammate holds a claim row; otherwise vendor name — spec persona-carry rule), and the guardrail sentence ("stay in character in conversational prose only; never in code, commits, PR text, or file contents; never alter workflow verdict labels").
3. **Handoff prompt fragment** (`buildRelayHandoffInput`, `mount-session-main.ts:65`): when `duo` is present, append exactly one persona line to the handoff input so the receiving agent re-learns its character on every turn. Teammate character is re-read from `listDuoAssignmentsForCollab` at handoff time (cheap sqlite read, mirrors `recordMountedSession`'s short-lived DB handle) so a teammate that mounted after us is picked up; fall back to the mount-time snapshot if the read fails.
4. **Kickoff-skill sections**: add a short "Duo roleplay" section to `packages/cli/skills/ai-whisper-sdd/SKILL.md`, `ai-whisper-ralph/SKILL.md`, `ai-whisper-bugfix/SKILL.md` — the persona is cosmetic, flavor lives in prose only, verdict labels and artifacts are never altered (guardrails verbatim from spec `:105-108`).

Tests first:

1. `buildRelayHandoffInput` unit tests: persona line present when `duo` set, absent when not; exactly one line; contains character + role + guardrail token.
2. Runtime injection test (existing mount-session test harness): brief injected once after bind, ≤3 lines, absent for `--no-duo`.
3. `pty-agent-env.test.ts` extension: `buildClaudePtySpawnOptions`/`buildCodexPtySpawnOptions` with a `baseEnv` containing `AI_WHISPER_CHARACTER*` pass the stamps through unchanged.

Files touched: `mount.ts`, `mount-session-main.ts`, 3 SKILL.md files, tests. (Skill edits are markdown-only; the code changes stay within 2 files.)

## Phase 5 — Display (dashboard + relay chrome)

Goal: character names visible wherever agent labels render, vendor name always recoverable, structural fallback for opted-out/unassigned agents.

Changes:

1. `packages/cli/src/runtime/agent-display.ts`: add pure sync helper `characterDisplayName(agentType: AgentType, characterName: string | null | undefined): string` → `"Batman (claude)"` when a character name is provided, else `agentDisplayName(agentType)` lowercase-vendor equivalent currently used by each surface. Pure and I/O-free — callers supply the assignment they already fetched.
2. Relay chrome (`mount-session-main.ts:468`): replace raw `directive.target` with `characterDisplayName(directive.target, <target's assignment name>)`, using the same per-handoff assignment read added in Phase 4 step 3: `[ai-whisper] Handed turn to Robin (codex).`
3. Dashboard: thread `listDuoAssignmentsForCollab` results into the dashboard snapshot (`dashboard-state.ts:659-689` already assembles per-collab session data on each poll tick; add the assignment map there) and map the label sites in `relay-view-state.ts` through `characterDisplayName`: turn row (`:382`), handoff route (`:125`), and the agent list adjacent to the health dots (`:388-402` — dots themselves stay glyphs). Agents without a row render exactly as today (raw vendor name), so a `--no-duo` mount can never appear as a character (spec enablement guarantee).

Tests first:

1. `characterDisplayName` unit tests: with name → `"Batman (claude)"`; null/undefined → vendor fallback; all four agent types.
2. `relay-view-state` tests (extend existing WallState/relay-view tests): snapshot with assignment map renders character labels; snapshot without renders vendor labels unchanged (regression guard).
3. Chrome test: handoff with target assignment present prints character form; absent prints vendor form.

Files touched: `agent-display.ts`, `mount-session-main.ts`, `dashboard-state.ts`, `relay-view-state.ts`, tests.

## Cross-cutting rules

- **TDD ordering within every phase**: write the listed tests first (red), implement to green, then run the full suite + typecheck. Never widen a phase's file list mid-flight — if a change wants a file outside the list, stop and re-plan that phase.
- **Broker/CLI dependency direction**: the broker package never imports the CLI duo table; character identity crosses the boundary once, as plain strings/ids inside `proposedRoll`, and lives on in the persisted `duo_roll`/`duo_assignment` rows — every later broker-side decision (second claim, inheritance, display reads) is answered entirely from those rows.
- **No relay/PTY byte-path changes anywhere in v1**: adapters' `handleData` and the relay pipe are untouched (mounted-PTY corruption was fought in RC1/RC2; the north-star viewport work is explicitly deferred to v2+ behind a flag).
- **Style safety**: every banner string ends with `\x1b[0m`; banner writes happen strictly before `runtime.start()` so no child bytes interleave.
- **Docs**: after Phase 3 lands, add a "Duo characters" section to `packages/cli/README.md` covering the default-on behavior, `--no-duo`, and `AI_WHISPER_DUO=off`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Schema bump re-runs migration body on existing DBs | body is fully idempotent (`CREATE TABLE IF NOT EXISTS` + guarded ALTERs); covered by a migration test on a v6-shaped fixture |
| Two mounts claim simultaneously | claim runs in `db.transaction(...).immediate()`; second transaction re-reads and takes the remaining slot — property-tested with interleaved claims |
| Codex wipes the banner | accepted + mitigated by design: 3s pause makes it visible, scrollback-push preserves it in history (spike-verified: codex never sends `ESC[3J`) |
| Narrow terminals mangle art | width guard falls back to name-only banner (spec decision 6) |
| Walter braille art needs font support | accepted per spec; cosmetic only, wiped anyway on codex |
| `process.env` mutation leaks into unrelated child processes of the mount | only two informational, namespaced vars; consistent with existing `AI_WHISPER_AGENT` stamping |
| Duo-enabled mount claims a character, then fails during spawn/claim completion | claim is additive and self-healing: the orphaned row's owner is dead, so the inherit-if-dead rule reclaims it and a same-agent remount resolves to `existing`; no live mount's state is destroyed |
| Handoff-time assignment read fails (DB contention) | fall back to mount-time snapshot; chrome/persona degrade to vendor names, never crash the relay |
| Dashboard poll overhead | one indexed PK-range read per tick; negligible |

## Out of scope (v1)

- Persistent top-right viewport art (north star, v2+, `mem-2026-07-02-duo-art-north-star-persistent-character-abe4a7`) — no VT parsing, no lied geometry, no reserved regions.
- Wiring role flavor to real workflow reviewer/evaluator semantics (roles stay cosmetic, spec `:11`).
- Trios / more than two characters per collab.
- Custom or user-supplied art packs.
