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
- No change to Wall **grouping, sorting, or liveness**, and no change to paging
  *semantics* or keybindings (the priority-fill order, the page-flip controls,
  and what belongs on which page are untouched). The card-height change below
  does intentionally alter how many cards fit per page and therefore the derived
  `pageCount` — that capacity/`pageCount` shift is an in-scope, expected
  consequence of taller cards, not a change to paging behavior.
- No new persisted columns — `workspace_root` already exists on `collab`.

## Decisions

- **cwd line is always shown** (not conditional on being a worktree). Uniform
  card height keeps the grid rows aligned; worktrees stand out by being longer.
- **Card height is a contract the allocator owns, updated in lockstep.**
  `fillOnePage` / `allocateWallSections` paginate using the `CARD_HEIGHT` constant
  (`packages/cli/src/runtime/dashboard-state.ts:187`), today `{ full: 6,
  compact: 4 }` (border 2 + content). Adding content lines WITHOUT bumping this
  constant makes the allocator reserve too few rows, so cards overflow the
  viewport or rows overlap. This redesign therefore updates `CARD_HEIGHT` to
  **`{ full: 7, compact: 5 }`** in the same commit that adds the lines.
- **`CARD_HEIGHT` is a budget = the MAX content lines a card of that kind renders;
  the renderer must never exceed it, but may render fewer.** Border (2) plus
  content gives the totals above: compact budget = **3** content lines, full
  budget = **5**. The allocator reserves the budget per card row, so a card that
  renders short (e.g. the stuck full card) just leaves a small gap at its
  bottom — always safe; a card that renders *taller* than the budget is the only
  failure mode, and is forbidden.
- **Compact cards always render the full 3 lines** (header, cwd, artifact) — the
  DONE/CANCELED pile is large and dense, so exact uniformity matters and is cheap.
  The artifact line is therefore **always present**: when there is no artifact it
  renders a muted placeholder (`→ —`) rather than collapsing the line, so an
  IDLE/manual card stays the same height as a DONE card.
- **Full cards render UP TO 5 lines** (header, cwd, artifact, progress/agents,
  event tail) and may render fewer — they are NOT padded to an exact height. The
  ACTIVE section is small, so minor height variance is acceptable, and the budget
  prevents overflow. Specifically: the stuck branch renders 4 lines (header, cwd,
  two why lines); a non-stuck card with no artifact shows a second event row via
  the existing `eventCount = artifact ? 1 : 2` displacement, and a card with fewer
  events than that simply renders fewer lines. None of these exceed the 5-line
  budget.
- **The stuck full card gets the cwd line too.** `FullCard` has a separate
  early-return branch for `statusKey === "stuck"`
  (`packages/cli/src/runtime/dashboard-view.tsx:106`) with its own header + why
  layout. The "cwd always shown" rule applies there as well — when a run is stuck
  you most want to know which worktree it is in. The stuck branch renders header
  + cwd + the (1-2) why lines; it stays at or under the `CARD_HEIGHT.full` budget,
  so the allocator is unaffected.
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

A compact card with no artifact (e.g. an IDLE/manual collab with no workflow)
keeps all 3 lines by rendering a placeholder on L3, so it stays the same height
as its row-mates:

```
┌────────────────────────────────┐
│ ◌ ai-ezio  idle                 │  L1
│ ⌂ ~/Dev/ai-ezio                 │  L2
│ → —                             │  L3: placeholder, height preserved
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

### Stuck full card (ACTIVE, `statusKey === "stuck"`) — adds the cwd line

The stuck branch keeps its red border + `⚠` header and the dominant why text,
and inserts the cwd line directly under the header:

```
┌──────────────────────────────────────────┐
│ ▸ ⚠ ai-14all  bugfix                       │  L1: header (red ⚠)
│ ⌂ ~/Dev/ai-14all/.worktrees/devel          │  L2: NEW cwd path (keepTail)
│   STUCK 6m12s — round 3/3 max reached →    │  L3: why (wrapped)
│   escalated                                │  L4: why cont.
└──────────────────────────────────────────┘
```

This is 4 content lines — at or under the `CARD_HEIGHT.full = 7` budget — so the
allocator is unaffected. The artifact line is intentionally absent on the stuck
card (the why text takes priority), and that is allowed because the card is
shorter than, not taller than, the budgeted height.

## Wall allocation & card height

`fillOnePage` (in `dashboard-state.ts`) reserves `HEADER_ROWS + ceil(cards /
colsCount) * CARD_HEIGHT[kind]` rows per section and stops filling when a card
row no longer fits, which also drives `pageCount`. Because this redesign adds
rendered content lines, **`CARD_HEIGHT` must change in the same commit that adds
those lines, or pagination silently breaks** (over-fills a page, truncates or
overlaps the bottom row, and miscounts pages).

| Card kind | Today | After | Content lines (after) |
|---|---|---|---|
| `compact` | 4 | **5** | header, cwd, artifact-or-placeholder |
| `full`    | 6 | **7** | header, cwd, artifact, progress/agents, event tail |

The constant is the per-kind MAX; the stuck full card may render fewer lines.
The existing `test/dashboard-wall-allocation.test.ts` asserts pagination against
these heights and MUST be updated, with a regression case proving that a viewport
sized to N old-height card rows yields the correct page count and per-page card
counts at the new heights (i.e. the allocator and the renderer agree).

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
3. **`dashboard-view.tsx`** — render the `⌂ <cwd>` line on all three card
   branches (compact, full, and the stuck full early-return); switch the artifact
   render to `keepTail(basename(artifact))`; render the `→ —` placeholder when the
   artifact is absent on a compact card.
4. **`dashboard-state.ts`** — bump `CARD_HEIGHT` to `{ full: 7, compact: 5 }` so
   `fillOnePage` paginates against the new rendered heights. This is the same file
   as step 2 but a distinct, easy-to-miss change; it is called out separately
   because the renderer and the allocator must move together.

## Increments (two commits)

**Commit 1 — readable filename (no threading).** Reflow the compact card so the
artifact gets its own full-width line (move status/elapsed to L1, drop progress);
add the `→ —` placeholder so a no-artifact compact card stays 2 content lines;
switch both cards' artifact render to `keepTail(basename(...))`; add the
`keepTail` helper. Compact stays 2 content lines (`CARD_HEIGHT.compact` unchanged
at 4); full card height unchanged (6).

**Commit 2 — cwd/worktree line.** Add `workspaceRoot` to `CollabSummary`, the
`cwd` field to `WallPaneState`, `abbreviateCwd`, and the `⌂` line on all three
card branches (compact, full, stuck full). Bump `CARD_HEIGHT` to
`{ full: 7, compact: 5 }` and update `test/dashboard-wall-allocation.test.ts` in
the SAME commit so the allocator and renderer stay in sync. Compact card becomes
3 content lines; full cards become 5.

## Edge cases

- `workspace_root` exactly equals `$HOME` → `~` (no trailing slash artifacts).
- `workspace_root` not under `$HOME` (e.g. `/tmp/...`) → shown verbatim (after
  `/private` strip), no `~`.
- Artifact is null/whitespace on a **compact** card → the artifact line renders
  the muted `→ —` placeholder (NOT an omitted line), preserving the fixed 3-line
  (2-line in commit 1) height so the card matches its row-mates.
- Artifact is null/whitespace on a **full** card → no artifact line; the
  event-count displacement (`eventCount = artifact ? 1 : 2`) shows a second event
  row instead, so the card renders up to 5 lines. If fewer than two events exist
  it renders fewer lines — allowed, because full cards are not padded and the
  budget covers the max (it must only never exceed 5).
- Stuck full card → renders the cwd line; the artifact line is intentionally
  absent (why text takes priority). Renders 4 lines, under the `CARD_HEIGHT.full`
  budget, which is allowed (full cards may be shorter than the budget, never
  taller).
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
- Compact card no-artifact height (view): a compact card with `artifact: null`
  renders the `→ —` placeholder and the SAME content-line count as a compact card
  with an artifact (2 lines in commit 1, 3 in commit 2) — guards uniform height.
- Full card (view): cwd line present; artifact shows basename + time tail; a
  normal active card renders exactly 5 content lines.
- Full card height budget (view): the rendered content-line count never EXCEEDS
  the `full` budget (5) across the representative cases — normal-with-artifact,
  no-artifact (event-displaced), no-artifact-with-fewer-than-two-events, and
  stuck. Cards may render fewer (4 for stuck, fewer for sparse), but never more.
  Compact equivalents render exactly the `compact` budget (3) in every case.
- Stuck full card (view): the `statusKey === "stuck"` branch renders the cwd line
  (asserts `⌂` + the path) alongside the `⚠` header and why text — guards against
  the early-return skipping the always-shown cwd line.
- Wall allocation (`test/dashboard-wall-allocation.test.ts`): pagination uses the
  new `CARD_HEIGHT` (`{ full: 7, compact: 5 }`). A regression case sizes the
  viewport so a known number of card rows fit and asserts the resulting
  `pageCount` and per-page card counts match the renderer's actual heights — i.e.
  no card row is budgeted shorter than it renders.
- `buildWallState`: `cwd` populated from `workspaceRoot`; null-safe when absent.
