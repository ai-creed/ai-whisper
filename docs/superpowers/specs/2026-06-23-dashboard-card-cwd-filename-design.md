# Dashboard Card UX — Readable Filename + Worktree/cwd Line

**Surface:** `whisper collab dashboard` (Ink TUI) — Wall mode, both card kinds
(`FullCard` for ACTIVE, `CompactCard` for DONE/CANCELED/HALTED/IDLE).

## Problem

Dogfooding the Wall with ~40 finished runs surfaced two identity defects (see
the 2026-06-23 screenshots):

1. **The artifact path is unreadable.** Compact card line 2 packs
   `→ <artifact> · P4/4 · done · <elapsed>` onto a single truncated row. With a
   ~30-column card the artifact budget collapses to a handful of characters, and
   `midEllipsis` keeps the path head + tail symmetrically — so the basename (the
   only identifying part) is gutted: `docs/…gn.md`. The elapsed field is also
   clipped (`253m2…`). The user cannot read the filename to look the run up.

2. **Worktree runs lose their parent; same-dir runs are indistinguishable.**
   The card `label` is already `basename(workspace_root)` (the broker sets
   `display_name` to the directory basename, and `wf.name` is usually null). So:
   - A worktree at `…/ai-14all/.worktrees/devel` shows only as `devel`, divorced
     from the `ai-14all` project it belongs to.
   - Many runs share the exact same `workspace_root` (e.g. several `ai-14all`
     runs in the main checkout). The label is identical across them; only the
     **artifact filename** distinguishes them — and that is exactly what
     problem 1 makes unreadable.

The two fixes are complementary: a **cwd line** reveals worktree↔project
location, and a **readable filename line** is the per-run disambiguator.

## Non-goals

- No change to the Inspector, which already shows the full artifact path and cwd
  when a card is selected.
- No change to Wall grouping, sorting, paging, or liveness.
- No new persisted columns — `workspace_root` already exists on `collab`.

## Decisions

- **cwd line is always shown** (not conditional on being a worktree). Uniform
  card height keeps the grid rows aligned; worktrees stand out by being longer.
- **`$HOME` is abbreviated to `~`** and a leading `/private` (macOS tmp/var
  symlink prefix) is stripped, so paths read as `~/Dev/ai-14all/.worktrees/devel`
  and `/tmp/deliberation-noanchor`.
- **Overflow clips the FRONT, keeping the end** (`keepTail`) for both the cwd
  path and the filename — the end carries the distinctive part (the worktree
  leaf; the topic + extension of a spec filename).
- **The artifact line shows the basename only** — the leading directory
  (`docs/superpowers/specs/`) is dropped. It is low-value and predictable, and
  the full path remains available in the Inspector.
- **Compact/DONE cards drop the `P4/4` progress token** — a finished run's
  completion is already conveyed by the status word and glyph. Active cards keep
  progress.

## Layout

### Compact card (DONE / CANCELED / HALTED / IDLE) — 3 lines

```
┌────────────────────────────────┐
│ ✓ devel  sdd · done · 5h12m     │  L1: glyph · label · type · status · elapsed
│ ⌂ ~/Dev/ai-14all/.worktrees/de… │  L2: abbreviated cwd path (keepTail)
│ → 2026-06-23-pr-e2e-gate-devel… │  L3: artifact basename (keepTail)
└────────────────────────────────┘
```

### Full card (ACTIVE) — adds the cwd line

```
┌──────────────────────────────────────────┐
│ ▸ ● ai-cortex  sdd  R1/5                   │  L1: unchanged header
│ ⌂ ~/Dev/ai-cortex                          │  L2: NEW cwd path (keepTail)
│ → 2026-06-23-library-design.md · HH:MM · 5h│  L3: artifact basename + time tail
│ P4/4 ▰▰▰▱  ezio●  claude●                   │  L4: unchanged progress/agents
│ fix  ezio→claude  –                         │  L5: unchanged event tail
└──────────────────────────────────────────┘
```

The full card's artifact line keeps its existing `· HH:MM · elapsed` time tail;
only the artifact portion changes from `midEllipsis(relPath)` to
`keepTail(basename)`.

## Helpers (pure, unit-tested)

- `keepTail(s, width)` — front-ellipsis: returns `s` unchanged when it fits,
  `"…" + s.slice(-(width-1))` when it overflows, a hard tail slice when
  `width <= 3`. Replaces `midEllipsis` at the two render sites.
- `abbreviateCwd(absPath, home)` — `$HOME`→`~`, strip a leading `/private`,
  return the display string unclipped (the view applies `keepTail` once it knows
  the pane width). Lives in `dashboard-state.ts` beside the other display
  derivations; `home` is injected (`os.homedir()`) so the helper stays pure.

## Data flow

`workspace_root` is already selected in `buildCollabSummary` (used today only for
the label fallback). Thread it out:

1. **`dashboard-repository.ts`** — add `workspaceRoot: string` to the
   `CollabSummary` type and the returned object.
2. **`dashboard-state.ts`** — add `cwd: string | null` to `WallPaneState`;
   populate it in `buildWallState` via `abbreviateCwd(summary.workspaceRoot, home)`.
3. **`dashboard-view.tsx`** — render the `⌂ <cwd>` line on both cards
   (`keepTail` to the pane budget); switch the artifact render to
   `keepTail(basename(artifact))`.

## Increments (two commits)

**Commit 1 — readable filename (no threading).** Reflow the compact card so the
artifact gets its own full-width line (move status/elapsed to L1, drop progress);
switch both cards' artifact render to `keepTail(basename(...))`; add the
`keepTail` helper. Card stays 2 lines (compact) / unchanged height (full).

**Commit 2 — cwd/worktree line.** Add `workspaceRoot` to `CollabSummary`, the
`cwd` field to `WallPaneState`, `abbreviateCwd`, and the `⌂` line on both cards.
Compact card becomes 3 lines.

## Edge cases

- `workspace_root` exactly equals `$HOME` → `~` (no trailing slash artifacts).
- `workspace_root` not under `$HOME` (e.g. `/tmp/...`) → shown verbatim (after
  `/private` strip), no `~`.
- Artifact is null/whitespace → no `→` line (existing behavior preserved).
- Artifact already a bare basename (fallback path) → `basename()` is a no-op.
- Very narrow pane (budget ≤ 3) → `keepTail` returns a hard tail slice, never an
  empty/`…`-only string.
- Long worktree path and long filename both clip independently on their own
  lines; neither steals the other's width.

## Test plan

- `keepTail`: fits-unchanged; overflow keeps tail + leading `…`; `width<=3` hard
  slice; `width<=1` guard.
- `abbreviateCwd`: `$HOME` prefix → `~`; exact `$HOME` → `~`; `/private/tmp` →
  `/tmp`; non-home path verbatim.
- Compact card (view): renders the full artifact basename on its own line with no
  `· P4/4 ·` packing; status + elapsed on L1; cwd line present and front-clipped
  for a long worktree path; worktree vs main paths both readable.
- Full card (view): cwd line present; artifact shows basename + time tail.
- `buildWallState`: `cwd` populated from `workspaceRoot`; null-safe when absent.
