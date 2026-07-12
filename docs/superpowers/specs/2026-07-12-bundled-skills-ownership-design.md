# Bundled Skills Ownership Migration — design

Status: awaiting approval
Date: 2026-07-12
Umbrella spec: `ai-shakespii/docs/superpowers/specs/2026-07-12-skill-ownership-migration-design.md` (approved; authoritative for scope and semantics). This document is the ai-whisper sub-spec (sub-project 1), distilling umbrella sections 4–6 into repo-local decisions.

## Summary

ai-whisper takes ownership of its nine companion skills. The bundle at `packages/cli/skills/` is reshaped from 8 stale pre-calibration templates to the 9 calibrated directories from ai-skills commit `91890bb`, copied bit-for-bit. `whisper skill install` replaces its throw-on-existing behavior with a semver version guard so repeated installs are safe and never silently downgrade an installed copy. CI gains a skills QA gate (shakespii lint + deterministic test + version-bump assertion), and AGENTS.md gains the version-bump rule.

Three implementation units, in order: (a) installer version guard, (b) bundle reshape, (c) CI + docs. Each is TDD-first where there is testable behavior.

## Content mapping (umbrella §4)

Source of truth for content: `~/Dev/ai-skills` at commit `91890bb` (verified: HEAD is `91890bb`, working tree clean for `skills/`). All nine skills carry `version: 0.1.0`.

| Bundle dir (`packages/cli/skills/`) | Today | After |
| --- | --- | --- |
| `ai-whisper-workflow` | absent | **add** — dispatcher + `references/workflow-types.md` + evals |
| `ai-whisper-sdd`, `-bugfix`, `-deliberation`, `-ralph` | full near-clone skills (retired XS02 cluster) | **replace** — thin aliases reusing the same dir names |
| `ai-whisper-code-review`, `-plan-execution`, `-quick-task`, `-deliberation-craft` | stale templates | **replace** — calibrated content |

Mechanics: delete all 8 existing dirs, copy the 9 calibrated dirs as full directories (SKILL.md, `evals/evals.json`, `evals/triggers.json`, `evals/files/` fixtures, `references/`) from the ai-skills checkout. The root-level `skills/.DS_Store` in ai-skills is not copied (copy per-directory; no `.DS_Store` exists inside any skill dir).

Constraints (umbrella version-continuity rule):

- Content lands **bit-for-bit** — no edits of any kind, `version` values unchanged at `0.1.0`.
- Verification: `diff -r` between each bundle dir and its ai-skills counterpart is clean immediately after the copy.
- `pnpm build` must carry the full dirs into `dist/skills/` — `packages/cli/scripts/copy-skills.mjs` already does a recursive `cp` of the whole tree, so this is verified, not implemented.

Evals travel with ownership (they are the skills' regression tests) and ride the bundle into dist and installs — the live corpus at `~/.claude/skills` already contains them, and the acceptance diff below requires them present.

## Installer version guard (umbrella §5)

Applies to `runSkillInstall` in `packages/cli/src/commands/skill/install.ts`. The current throw-on-existing-destination check is removed entirely and replaced by a per-skill, per-target guard. A plain `whisper skill install` becomes safe and idempotent to run repeatedly, across all five provider targets (claude, codex, cursor, ezio, agy).

### Guard table

Compare the bundled skill's frontmatter `version` against the installed `SKILL.md` at the destination, semver ordering:

| Condition | Action | Reported as |
| --- | --- | --- |
| destination missing | install | `installed` |
| bundled > installed | install (upgrade) | `installed` |
| bundled == installed | skip | `up-to-date` |
| bundled < installed | skip | `skipped-newer` (message points at `--force`) |
| installed SKILL.md unreadable or missing `version` | treat installed as older → install | `installed` |
| `--force` | always install, report what was replaced | `installed` (forced, with replaced version) |

Repo-local extension to the umbrella table (which only covers the installed side): a **bundled** skill with missing or malformed `version` is treated as `0.0.0`. It installs fine into a missing destination but never overwrites a versioned installed copy without `--force` — the guard must not become a downgrade vector via a broken bundle. In practice CI lint keeps bundled versions present.

### Version parsing and comparison

- Frontmatter scan, no YAML dependency: within the first `---` ... `---` block of `SKILL.md`, the first line matching `version:` yields the value. Anything malformed (no frontmatter, no match) falls into the missing-version rows above.
- Semver compare, no dependency: split on `.`, numeric compare of major/minor/patch; missing parts compare as 0; any non-numeric part makes the whole value malformed. (Calibrated versions are plain `x.y.z`; prerelease/build syntax is out of scope and treated as malformed.)

### Result reporting

Install no longer aborts on first conflict; every skill × target pair is processed and reported.

```ts
export type SkillInstallAction = "installed" | "up-to-date" | "skipped-newer";

export interface SkillInstallEntry {
	skill: string;
	target: AgentType;
	dest: string; // skill directory at the destination
	action: SkillInstallAction;
	bundledVersion: string | null;
	installedVersion: string | null; // pre-install version at dest, null if absent/unreadable
	forced?: true; // present when --force overwrote a skip case
}

export interface SkillInstallResult {
	results: SkillInstallEntry[];
	installedAt: string[]; // kept: SKILL.md paths actually written (derived from results)
}
```

The CLI action in `create-cli.ts` prints one line per entry (`installed` / `up-to-date` / `skipped-newer (installed 0.2.0 > bundled 0.1.0 — use --force to downgrade)`), replacing the current `Installed: <path>` loop. Failure honesty rule: a skip is reported as a skip, never as a successful install.

An install step is still allowed to throw only for environmental errors (unknown target, missing bundle dir, unwritable destination) — never for a version conflict.

### Tests (TDD, written before the implementation change)

Extend `test/skill-install.test.ts` with the guard-table cases:

1. destination missing → `installed`, file written
2. bundled newer than installed → `installed`, content replaced
3. versions equal → `up-to-date`, destination byte-identical afterwards (zero writes)
4. bundled older than installed → `skipped-newer`, destination untouched, no throw
5. installed SKILL.md present but no `version` field → `installed` (upgrade-in-place — this is the migration path for old versionless clones)
6. `--force` over a newer installed copy → `installed` with `forced` and the replaced version reported
7. mixed corpus in one run: one of each outcome, all reported, none aborts the others
8. bundled SKILL.md with missing or malformed `version` (treated as `0.0.0`): against an installed copy at `version: 0.1.0` without `--force` → `skipped-newer`, destination untouched, no throw; against a missing destination → `installed`. Regression guard for the repo-local extension above — a broken bundle must never become a downgrade vector.

The existing test "without --force, existing destinations are NOT overwritten and the command reports the conflict" asserts the old throw behavior and is superseded — it is rewritten as guard-table case 5 (versionless existing copy is upgraded, not preserved). All other existing tests (target routing, ezio/agy paths, invalid target, empty/missing bundle) remain valid unchanged.

## CI skills QA and docs (umbrella §6)

### Placement

QA runs as **steps appended to the existing `verify` job** in `.github/workflows/ci.yml`, not a separate job: the workflow's two-repo checkout (ai-ezio file dependencies) makes a standalone job pay the full checkout/install cost again for no isolation benefit. `shakespii@^0.3.1` (public npm) is added as a root devDependency so the same commands run locally and in CI; no private-repo dependency.

### Steps

1. **Lint** — `shakespii lint <dir> --json` for each of the 9 bundled skill dirs. Any error-severity finding fails the build; warnings are printed but pass.
2. **Deterministic test** — `shakespii test <dir> --json` for each dir, without `--run` or `--triggers` (those flags spend live model sessions; live trigger/grading sweeps stay manual calibration campaigns, explicitly out of CI). This validates structure and eval schema only.
3. **Version-bump assertion** — a new script `scripts/check-skill-version-bump.mjs`: for each bundled skill dir whose content differs from the base ref, the `version` value in that dir's SKILL.md must also differ. Base ref resolution: on `pull_request`, the merge-base with the base branch; on `push`, `github.event.before`; when the base is unresolvable (first push, force push, shallow-clone miss), the step skips with a visible notice rather than guessing. The umbrella's diff-against-release-tag suggestion is rejected for this repo: tags are stale (latest `v0.9.0` against package version 0.14.0), so a tag base would produce false positives forever.

Both new CI steps and the workflow edit are validated with `actionlint` before pushing (repo gotcha: local gates do not cover workflow YAML).

### AGENTS.md rule

Add to AGENTS.md (Documentation Policy section or a new Bundled Skills section):

> Any content edit to a skill under `packages/cli/skills/` must bump that skill's `version` frontmatter in the same change — guarded installers silently skip unbumped content. CI enforces this.

## Acceptance test (whole sub-project)

From the built CLI (`pnpm build` first):

1. `whisper skill install --target claude` against the live corpus at `~/.claude/skills` reports **every one of the 9 skills as `up-to-date`** and performs **zero writes** (the live corpus already holds the calibrated versions). Zero-writes is verified by comparing directory mtimes/content before and after, not by trusting the report.
2. `diff -r` between every `packages/cli/skills/<dir>` and `~/.claude/skills/<dir>` is clean.
3. Full repo gates pass: `pnpm test`, root `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## Out of scope

- ai-14all and ai-skills repos (sub-projects 2 and 3); ai-shakespii governance closure (sub-project 4).
- Any skill content change beyond the bit-for-bit copy — parked content edits ship later as normal versioned product edits.
- Multi-provider trigger calibration; shakespii provenance stamping (Approach C, parked upstream).
