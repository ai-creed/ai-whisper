# Mount Duo Art — v1 "Draw on Initializing"

Status: design settled, not yet implemented
Date: 2026-07-02
Revision: 2026-07-02b — opt-out semantics reconciled with display design after workflow review (assignment persistence moved to per-agent claim rows; `--no-duo` never claims and releases stale rows)
Memories: `mem-2026-07-02-duo-art-v1-design-settled-seven-duos-78d66b` (decision), `mem-2026-07-02-duo-art-north-star-persistent-character-abe4a7` (deferred north star)

## Summary

A fun feature for `whisper collab mount <agent>`: each collab run assigns the mounted agents a pair of movie-duo character identities (e.g. Walter White = reviewer, Jesse = implementer). At mount time, before the agent CLI spawns, whisper prints an ASCII character sketch and a themed "summoning" line. Character names can also appear later in relay chrome and the dashboard summary bar.

Roles (reviewer/implementer flavor) are cosmetic in v1 — rolled at assignment time, not wired to actual workflow reviewer/evaluator semantics.

## Spike findings (verified 2026-07-02)

Spawn chain for a mounted session:

```
runCollabMount                    packages/cli/src/commands/collab/mount.ts:82
  └─ runtime.start()              mount.ts:386
      └─ createMountSessionRuntime.start()   runtime/mount-session-main.ts:204
          └─ await liveSession.start()       mount-session-main.ts:512  ← PTY spawns here
              └─ interactiveSession.start()  live-session.ts:340
                  └─ node-pty spawn + onData attach
                     packages/adapter-claude/src/create-claude-live-session.ts:100-108
```

Everything before `runtime.start()` runs in the whisper CLI's own process with full ownership of stdout — no relay, no PTY, no agent process. Art printing is a plain write in the command layer.

Startup-byte capture of both agent TUIs under node-pty (raw first ~5s):

| Behavior | claude (v2.1.198) | codex |
|---|---|---|
| Alternate screen (`ESC[?1049h`) | no | no |
| Viewport clear | no | `ESC[1;1H` + `ESC[J` at ~byte 63 (first frame) |
| Scrollback erase (`ESC[3J`) | no | no |
| Render model | inline/relative, appends | absolute positioning + per-row `ESC[K`, owns whole viewport |

Consequences:

- **claude side:** banner art survives naturally; it scrolls up as the TUI grows and stays in scrollback.
- **codex side:** art is wiped from the viewport almost instantly after spawn, and because the wipe is an in-place erase (not a scroll), the art never reaches scrollback on its own. Codex never sends `3J`, so scrollback itself is untouchable.

## Design decisions

1. **Ship all seven duos baked into the npm package** (trademark gray-zone accepted; no local-art-dir gating):
   - Sherlock & Watson (public domain)
   - Frankenstein & Igor (public domain)
   - Don Quixote & Sancho Panza (public domain)
   - C-3PO & R2-D2
   - Batman & Robin
   - Rocket & Groot
   - Walter White & Jesse Pinkman
2. **Art insertion point:** in `runCollabMount`, after `resolveOrCreate()` (mount.ts:295 — collabId is needed for the duo-consistency lookup) and before `runtime.start()` (mount.ts:386). Precedent: the turn-events startup line already prints chrome in this window (mount.ts:150).
3. **Codex mitigations:** after printing art, hold a dramatic pause (~3s), then print `stdout.rows` newlines to push the art off the top into scrollback before the spawn ("scrollback-push"). The pause makes the summoning visible; the push preserves the art in history.
4. **Cross-terminal duo consistency:** character assignments are persisted in the broker sqlite as per-agent claim rows keyed by `(collabId, agentType)`. The first duo-enabled mount rolls the duo pair (random per run) for the collab and claims one character; the next duo-enabled mount claims the remaining character. A row exists only for an agent that actually claimed a character — a `--no-duo` mount never creates one. Two mounts are separate processes with no shared memory — the DB is the only shared state.
5. **Third+ mount rule:** a newly mounting duo-enabled agent inherits a duo character only if that character's previous owner session is dead (stale/degraded attachment). If both duo slots have live owners, the extra mount falls back to the plain agent vendor name (codex/claude/ezio/agy). No trios in v1.
6. **Terminal-width guard:** if `stdout.columns` is smaller than the art width, fall back to a name-only banner line.
7. **Style reset:** always emit `ESC[0m` after the art block so the child TUI doesn't inherit a dangling color/style.

## Art assets

Pre-baked ASCII art files bundled with the CLI package (e.g. `packages/cli/assets/duos/<character>.txt`), one per character. Curated set approved 2026-07-02 (gallery reviewed in-terminal); all pieces fit ≤80 cols. Sourced from classic ASCII art collections with artist signatures kept embedded per community etiquette (`jgs` = Joan Stark, `bug` = Blazej Kozlowski, `jsm`, `jrei`, `ejm/a:f/mic`, and anonymous braille/conversion pieces). Robin is the only hand-crafted piece (no historical Robin ASCII art exists). Walter White uses Unicode braille (accepted — requires a braille-capable terminal font); Jesse uses an ASCII grayscale conversion. Don Quixote & Sancho Panza share a single combined scene (windmill charge) shown on both terminals.

## Punchlines

Each character has an iconic one-liner printed beneath the art at summon time:

| Character | Punchline |
|---|---|
| Sherlock | "Elementary, my dear Watson." |
| Watson | "By Jove, Holmes — it works!" |
| Frankenstein | "It's alive! IT'S ALIVE!" |
| Igor | "It's pronounced 'eye-gor'." |
| Don Quixote | "Those are not windmills — they are giants!" |
| Sancho Panza | "Señor... those are windmills." |
| C-3PO | "We're doomed!" |
| R2-D2 | "Beep boop bee-boop." |
| Batman | "I'm Batman." |
| Robin | "Holy merge conflict, Batman!" |
| Rocket | "Ain't no thing like me, 'cept me!" |
| Groot | "I am Groot." |
| Walter White | "I am the one who knocks." |
| Jesse | "That's science, b*tch!" |

Banner layout:

```
⚡ Summoning HEISENBERG as reviewer...

        <art>

   "I am the one who knocks."
```

## Persona carry — the agent knows its character

Design follows `mem-2026-05-27` (mid-workflow agent guidance = prompt fragment primary + kickoff-skill section for discoverability, never a new standalone skill). Three channels:

1. **Session-start persona brief (bootstrap):** after the mount binds, inject a ≤3-line brief via the existing `injectedWrite` path (mount-session-main.ts:391) — universal across claude/codex/agy/ezio, no per-provider argv hacks. Example: "For this collab session you are BATMAN — the reviewer of this duo. Your teammate codex is ROBIN, the implementer. Stay in character in conversational prose only." The teammate is referenced by character name only if that teammate holds a claimed character row; when the teammate opted out (no row), the brief uses the plain vendor name.
2. **Relay handoff prompt fragment (reliable mid-workflow channel):** append one persona line in `buildRelayHandoffInput` (mount-session-main.ts:65) so the receiving agent re-learns its character on every handoff. Survives context compaction; same mechanism the review protocol uses.
3. **Kickoff-skills section (discoverability):** short "duo roleplay" section in the existing bundled kickoff skills (`ai-whisper-sdd`, `ai-whisper-ralph`, `ai-whisper-bugfix`). No new standalone skill.

Also stamp `AI_WHISPER_CHARACTER=<character>` and `AI_WHISPER_CHARACTER_ROLE=<role>` into the child PTY env at spawn (next to the existing `AI_WHISPER_AGENT` stamp, create-claude-live-session.ts:74) so shelled-out `whisper` commands and hooks can read the character.

**Guardrails:**
- Character flavor lives in conversational prose ONLY — never in code, commit messages, PR text, or file contents.
- Workflow verdict labels are untouched: the reviewer still emits protocol-compliant approve/reject output (per the reviewer/evaluator protocol decisions). Flavor may surround the verdict, never replace or alter it.
- Persona brief stays ≤3 lines — it rides every handoff, token cost matters.

## Dashboard & relay chrome display

- Add a collab-aware sibling to `agentDisplayName()` (runtime/agent-display.ts): `characterDisplayName(collabId, agentType)` → "Batman (claude)"; falls back to the plain vendor name when that agent has no claimed character row — either because it never mounted duo-enabled or because a `--no-duo` remount released the row.
- Dashboard live view uses it wherever agent labels render; vendor name stays in parens for operational clarity.
- Relay chrome uses it too: `[ai-whisper] Handed turn to ROBIN.` (mount-session-main.ts:468).

## Enablement — default ON, opt-out

Duo mode is ON by default in `whisper collab mount`. Opt-out follows the `--turn-events` precedence pattern (flag > env > default):

- Flag: `--no-duo` on `whisper collab mount`.
- Env: `AI_WHISPER_DUO=off` for permanent opt-out.
- One switch disables ALL surfaces for that mount: banner art, persona injection, env stamp, and dashboard/relay-chrome naming. Display stays consistent because it keys on per-agent claim rows (design decision 4): a `--no-duo` mount never claims a character row, and on binding it releases any stale row left for its agent type by a previous duo-enabled mount of the same collab. With no row present, `characterDisplayName` resolves to the vendor name, so a `--no-duo` mount is never rendered as a character even in a collab where the other agent is duo-enabled.
- Opt-out is per mount, not per collab: the other agent's duo surfaces are unaffected. A persona brief injected into a duo-enabled agent references an opted-out teammate by vendor name (no character row to read).

## Implementation phases

1. **Duo table + art assets** — pure module (names, roles, art refs, punchlines) + 14 asset files + roll logic. TDD, no I/O.
2. **Assignment persistence** — broker sqlite table + repository; per-agent claim rows (roll the pair once per collab, claim per duo-enabled mount); release row on `--no-duo` remount; inherit-if-dead via existing pid probing.
3. **Banner wiring** — render (width guard, art, summon line, punchline, style reset), pause, scrollback-push, insert after `resolveOrCreate()` in mount.ts; `--no-duo` flag + env.
4. **Persona carry** — env stamp, injected brief, handoff fragment, kickoff-skill sections.
5. **Display** — `characterDisplayName` helper, dashboard live view, relay chrome.

## North star (v2+, deferred)

Persist the character art in the top-right corner of the PTY viewport for the whole session, so the operator always sees which character owns which role. Requires mini-tmux machinery in the relay: lied PTY geometry, a streaming VT-sequence parser translating absolute cursor addressing, filtering of child scroll-region resets, and guarding of the reserved region. The interception point already exists (all child bytes flow through `handleData` in the adapters). High fragility risk — mounted-PTY corruption was fought before (RC1/RC2); build behind a flag. See the deferred memory for details.

## Implementation notes (for planning)

- New module: duo table (names, roles, art file refs) + assignment roll logic.
- Broker storage: small table or reuse of an existing per-collab store for claim rows `{collabId, agentType, character, role, assignedAt}` keyed by `(collabId, agentType)`; rows exist only for duo-enabled claimers and are deleted when a `--no-duo` mount binds that agent type.
- Liveness for the inheritance rule can reuse the same session-attachment pid probing mount already does for binding reclaim (mount.ts:341-362).
- Banner rendering: width check, art print, themed summon line, `ESC[0m` reset, pause, scrollback-push (codex only or uniformly — uniform is simpler and harmless for claude).
