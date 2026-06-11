# ai-whisper-plan-execution Skill + Workflow Guidance Fragment — Design

**Date:** 2026-06-12 · **Status:** approved design, ready for planning
**Ideas doc:** `docs/superpowers/notes/2026-06-12-ai-whisper-plan-execution-skill-and-model-allocation.md`

## 1. Problem

During the SDD workflow's plan-execution phase, the implementer receives a bare
"Execute the plan at {planPath}" handoff. In a real run (keep-ezio-fresh,
2026-06-11) the claude implementer executed the entire plan manually — no
subagents, no per-task review, every token at its own (most expensive) tier —
and silently ignored the plan's `REQUIRED SUB-SKILL:
superpowers:subagent-driven-development` header. Two gaps caused this:

1. **No mid-workflow trigger.** Mid-workflow, an agent invokes no skill on its
   own; the handoff prompt is the only reliable in-context channel
   (mem-2026-05-27-…-a6702d). The plan-execution templates carry no skill
   guidance today, unlike the review templates which carry
   `CODE_REVIEW_SKILL_GUIDANCE`.
2. **Perceived misfit.** The global superpowers skills read as
   human-in-the-loop (escalate to the human, finishing-a-development-branch),
   giving the agent an excuse to skip them inside an autonomous workflow.

## 2. Decisions (from brainstorm, 2026-06-12)

| # | Decision |
|---|----------|
| 1 | **Both review layers.** Compose `superpowers:subagent-driven-development` intact (per-task two-stage subagent review during execution); the workflow's code-review phase remains the macro acceptance gate. Different granularities: micro catches compounding per-task errors early, macro validates the whole deliverable against the spec. |
| 2 | **Universal fragment, skill branches.** The guidance fragment is added statically for all implementers; the skill itself branches by harness capability. The non-claude path must never block or confuse codex/ezio. |
| 3 | **Default fan-out + small-plan escape.** Fan out by default; inline execution is allowed only for plans with ≤2 tasks or purely mechanical single-concern work (one repetitive transformation, e.g. a rename or codemod sweep), and the handback must disclose that inline was chosen and why. |
| 4 | **Packaging: bundled skill + fragment** (code-review precedent, mem-2026-06-04-…-d67c11): a new bundled skill in `packages/cli/skills/` plus a ≤2-sentence guidance constant in the workflow registry. Fragment = reliable trigger; skill = full procedure. |
| 5 | **Name:** `ai-whisper-plan-execution` — noun form matches sibling skills and the workflow phase name `plan-execution`. |
| 6 | **Mandate, don't suggest.** When `superpowers:subagent-driven-development` is available the implementer MUST invoke it; when absent, the skill's built-in minimal protocol mimics it. The handback always names the execution mode used. |
| 7 | **Sequential task execution.** `subagent-driven-development` itself forbids parallel implementation dispatch ("Never: Dispatch multiple implementation subagents in parallel (conflicts)"). No parallel mode in v1. |

## 3. Design overview

Two artifacts, mirroring the established code-review pattern
(`packages/broker/src/runtime/workflow-registry.ts:152-167`):

1. **Bundled skill** `packages/cli/skills/ai-whisper-plan-execution/SKILL.md` — ships in the
   npm package and installs to all three agent skill directories via the
   existing readdir-driven `whisper skill install` (no install-code change).
2. **Guidance fragment** `PLAN_EXECUTION_SKILL_GUIDANCE` — a new exported
   constant in `workflow-registry.ts`, appended to the SDD plan-execution
   phase's task statement (kickoff + execute templates).

Division of authority (same as code-review): the **workflow prompt controls
the contract** (what to deliver, handback shape); the **skill controls the
method** (how execution is structured). The workflow driver, phases, evaluator
prompts, and handback plumbing are untouched.

Data flow: phase start → driver renders kickoff (fragment included) →
implementer invokes the skill → skill branches by harness capability → tasks
executed sequentially (fan-out or inline) → verification passes → commits →
handback with commit SHAs + verification output + summary + execution mode →
execution-gate evaluator → code-review phase (unchanged) reviews the full
commit range.

**Scope (v1):** the fragment is wired into the SDD plan-execution phase only.
Ralph chunks are deliberately small (fan-out is overhead, not help) and the
bugfix fix phase is not plan-shaped. The skill body itself is written
workflow-agnostically ("when executing an implementation plan as the
implementer inside an ai-whisper autonomous workflow") so wiring it elsewhere
later is a one-line template addition.

## 4. Artifact 1 — `packages/cli/skills/ai-whisper-plan-execution/SKILL.md`

### 4.1 Frontmatter

```yaml
---
name: ai-whisper-plan-execution
description: Use when executing an implementation plan as the implementer inside an ai-whisper autonomous workflow (plan-execution phase). Structures HOW to execute — subagent fan-out with model allocation where the harness supports it, disciplined inline execution otherwise.
---
```

### 4.2 Gating

Implementer role only, inside an autonomous workflow. Never used by the
reviewer; never for ad-hoc edits outside a workflow
(mem-2026-05-22-…-acc168 precedent: scope bundled skills to the autonomous
workflow context they serve).

### 4.3 Step 0 — fan-out decision

Read the plan once; extract all tasks with their full text. Decide:

- **Default: fan out** (Path A or its fallback).
- **Inline escape, only if** the plan has ≤2 tasks, OR is purely mechanical
  single-concern work (one repetitive transformation such as a rename or
  codemod sweep). Inline execution still follows the plan task-by-task with
  per-task verification.
- Whichever branch is taken, the handback must name the mode (§4.6).

### 4.4 Path A — harness with subagent dispatch (Claude Code)

1. **Hard directive:** if `superpowers:subagent-driven-development` appears in
   the session's available skills, the implementer MUST invoke it and follow
   its per-task loop (fresh implementer subagent per task → spec-compliance
   review → code-quality review, with fix-and-re-review loops). Skipping it to
   "just execute directly" is a contract violation, not a judgment call. The
   skill text pre-empts the known rationalizations: continuous execution is
   already built into subagent-driven-development, and the autonomous-context
   misfits are explicitly overridden in (2) — they are not reasons to skip.
2. **Workflow overrides** (apply while inside an ai-whisper workflow):
   - "Escalate to the human" (BLOCKED, plan itself wrong) → hand back that you
     CANNOT PROCEED and why; the workflow escalation path handles it.
   - `superpowers:finishing-a-development-branch` (final step) → do not use;
     the workflow handback replaces it. Merging is the operator's decision.
   - "Never start implementation on main/master without explicit user
     consent" → the collab-mounted workspace/branch is operator-provided;
     mounting is that consent.
3. **Fallback — built-in minimal protocol** (only when
   `superpowers:subagent-driven-development` is NOT available; it mimics the
   same loop): for each task, sequentially: dispatch a fresh implementer
   subagent carrying the full task text + scene-setting context (never make a
   subagent read the plan file); then a spec-compliance reviewer subagent; then
   a code-quality reviewer subagent; loop fixes until both approve. Never
   dispatch implementation subagents in parallel.
4. **Model allocation policy** — governs subagent dispatch only (the
   implementer's own model is fixed by `whisper collab mount`). Refines
   subagent-driven-development's generic Model Selection section with concrete
   aliases and two invariants it lacks:

   | Subagent role | Default | Flip condition |
   |---|---|---|
   | Task implementer | `sonnet` | ↑ strongest tier if ambiguous / novel / cross-cutting / security-sensitive |
   | Reviewer (spec or quality) | strongest available (`opus`+) | never below the task implementer's tier |
   | Mechanical / codemod | `haiku` | ↑ `sonnet` if it touches shared types or public API |
   | Test-writer | `sonnet` | ↑ strongest tier for adversarial/repro tests; never `haiku` |
   | Verification runner | `haiku` | ↑ `sonnet` if it must diagnose failures, not just report them |

   Invariants: **reviewer tier ≥ implementer tier, always** (a weaker reviewer
   rubber-stamps what it cannot distinguish); on the **2nd failed review of the
   same task, bump the task implementer one tier** and pass the failure history
   into the new dispatch. Aliases, not versioned model names, so the text does
   not rot as models ship.

### 4.5 Path B — no subagent dispatch (codex / ezio)

One short paragraph, no Claude-tool references: execute the plan inline,
task-by-task in plan order, run per-task verification, commit as the plan
specifies, and hand back per the workflow prompt. Path A does not apply —
nothing in this skill blocks or changes the handback for agents without
subagent dispatch.

### 4.6 Handback discipline (both paths)

The workflow prompt remains authoritative
(mem-2026-06-04-…-13e558 precedent). Before handing back: all subagents
settled, verification green, work committed. The handback contains the commit
SHAs, the verification output, the 1-2 sentence summary the workflow prompt
demands, and **one line naming the execution mode**:
`subagent-driven (superpowers)` | `subagent-driven (built-in protocol)` |
`inline (<reason>)`. A silent manual run is thereby visible to the evaluator,
the code-review phase, and the operator.

### 4.7 Failure handling

- Subagent dies or hangs → retry once; then do that task inline at the
  orchestrator's own tier and disclose it in the handback.
- 2nd failed review of the same task → tier escalation per §4.4(4).
- Plan unreadable or not task-shaped → execute inline with disclosure; never
  block the workflow on skill-internal structure.
- Verification red after all tasks → fix before handing back (the workflow
  template already requires passing verification); never hand back red.

## 5. Artifact 2 — guidance fragment in `workflow-registry.ts`

New exported constant (final wording; ≤2 sentences like
`CODE_REVIEW_SKILL_GUIDANCE`):

```ts
// Plan-execution skill guidance appended to the SDD plan-execution handoffs.
// It tells the implementer to use the ai-whisper-plan-execution skill for HOW
// to execute the plan (subagent fan-out + model allocation where supported),
// while the task statement above it remains authoritative for WHAT to deliver
// and the handback contract.
export const PLAN_EXECUTION_SKILL_GUIDANCE =
	"Use the ai-whisper-plan-execution skill to structure HOW you execute this plan: subagent fan-out with model allocation where your harness supports it, disciplined inline execution otherwise. The handback contract above remains authoritative — settle all delegated work before handing back, and state which execution mode you used.";
```

Wiring: extract the currently-duplicated plan-execution template literal into a
shared `SDD_PLAN_EXECUTION` constant (the existing `SDD_SPEC_REVIEW` /
`SDD_CODE_REVIEW` idiom), composed as the existing task statement +
`"\n\n"` + `PLAN_EXECUTION_SKILL_GUIDANCE`, used by both `kickoffTemplate` and
`stepTemplates.execute` of the SDD `plan-execution` phase. Ordering mirrors
`SDD_CODE_REVIEW`: task statement first, then guidance.
`withOperatorControl` continues to append the operator-control fragment after
it (kickoff only), unchanged. No other phase or workflow gains the fragment in
v1.

## 6. Touched surfaces

| File | Change |
|---|---|
| `packages/cli/skills/ai-whisper-plan-execution/SKILL.md` | New — content per §4. |
| `packages/broker/src/runtime/workflow-registry.ts` | New `PLAN_EXECUTION_SKILL_GUIDANCE` const; extract shared `SDD_PLAN_EXECUTION` const; wire into the plan-execution phase templates. |
| `README.md` | Add the skill to the bundled-skills section (readme-smoke pins mentions). |
| `AGENTS.md` | One-line pointer: plan execution with subagents follows the bundled `ai-whisper-plan-execution` skill's model-allocation policy. |
| `test/wf-plan-execution-guidance.test.ts` | New — mirror of `test/wf-code-review-guidance.test.ts` (see §7). |
| `test/plan-execution-skill.test.ts` | New — mirror of `test/code-review-skill.test.ts` (see §7). |
| Existing tests pinning the plan-execution template text | Update to the new composed template (locate during planning via `rg "Execute the plan at" test/`). |

No changes to: workflow driver/control flow, evaluator prompts, handback
plumbing, `whisper skill install` (readdir-driven), `copy-skills.mjs`.

## 7. Testing strategy

`test/wf-plan-execution-guidance.test.ts` (fragment wiring):
- `PLAN_EXECUTION_SKILL_GUIDANCE` is exported and non-empty; names the skill.
- SDD plan-execution `kickoffTemplate` and `stepTemplates.execute` both contain
  the fragment, positioned after the "Execute the plan at {planPath}" task
  statement.
- The kickoff template (post-`withOperatorControl`) still ends with the
  operator-control fragment; the handback-contract sentence is intact.
- No other SDD phase template and no ralph/bugfix template contains the
  fragment.

`test/plan-execution-skill.test.ts` (skill content invariants):
- `packages/cli/skills/ai-whisper-plan-execution/SKILL.md` exists with frontmatter
  `name: ai-whisper-plan-execution` and a description containing the
  autonomous-workflow gating.
- Body contains: the MUST-invoke directive naming
  `superpowers:subagent-driven-development`; the built-in fallback protocol;
  the model table with the reviewer ≥ implementer invariant and the
  2nd-failed-review escalation; the ≤2-task inline escape with disclosure; the
  execution-mode handback line (all three mode strings); the Path B
  non-blocking paragraph; the no-parallel-dispatch rule.

Plus: readme-smoke update for the new skill mention; full verification quartet
(`test` / `typecheck` / `lint` / `build`) before completion per AGENTS.md.

## 8. Out of scope (v1)

- Parallel task execution — `subagent-driven-development` itself forbids it;
  doing it safely needs per-task worktree isolation + merge orchestration
  (its own future design).
- Wiring the fragment into ralph / complex-bug-fixing workflows.
- Cost ceilings / token budgets for subagent fan-out.
- Evaluator or handback-contract changes.
- The implementer's own model (fixed at `whisper collab mount`).

## 9. References

- Ideas doc: `docs/superpowers/notes/2026-06-12-ai-whisper-plan-execution-skill-and-model-allocation.md`
- Pattern precedent: `CODE_REVIEW_SKILL_GUIDANCE`, `packages/broker/src/runtime/workflow-registry.ts:152-167`; `withOperatorControl`, same file `:422`.
- Memories: `mem-2026-06-04-bundle-code-review-skill-inside-ai-d67c11` (bundle substantive procedure skills), `mem-2026-05-27-mid-workflow-agent-guidance-prompt-a6702d` (fragment is the reliable mid-workflow channel), `mem-2026-05-22-ai-whisper-wf-review-review-is-to-acc168` (naming + autonomous gating), `mem-2026-06-04-code-review-skill-output-follows-13e558` (workflow prompt authoritative over skill output), `mem-2026-05-22-do-not-bundle-wf-review-as-a-skill-c298a6` (boundary: a bundled skill must carry substantive method content — a thin skill pointing back at the prompt is forbidden; this skill passes because the fan-out protocol, model policy, fallback, and failure handling are behavior the prompt does not carry).
- Composed skill: `superpowers:subagent-driven-development` v5.1.0 (sequential per-task loop, two-stage review, generic Model Selection section, continuous execution; forbids parallel implementation dispatch).
