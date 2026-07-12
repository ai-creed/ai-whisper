---
name: ai-whisper-plan-execution
description: Use when executing an approved implementation plan as the implementer inside an active ai-whisper autonomous workflow (e.g. the SDD or quick-task plan-execution phase), never as the reviewer or for ad-hoc edits outside a workflow — subagent fan-out with model allocation where the harness supports it, disciplined inline execution otherwise; the workflow handoff prompt stays authoritative for WHAT to deliver and the handback contract.
version: 0.1.0
---

# ai-whisper-plan-execution

## Intent

Structure HOW you execute an approved implementation plan inside an
ai-whisper autonomous workflow, as the implementer. The workflow's handoff
prompt stays authoritative for WHAT to deliver and the handback contract;
this skill only governs execution structure — the fan-out decision, the
model allocation across dispatched subagents, and the two execution paths
(subagent-driven vs inline).

## Inputs

- The approved implementation plan, with every task's full text (path or
  already-supplied text).
- The workflow's handoff prompt — authoritative for WHAT to deliver and the
  handback contract this skill's Output section must satisfy.
- Whether the current harness supports subagent dispatch (e.g. Claude Code
  does; Codex, ezio, agy do not) — determines Path A vs Path B.
- Whether `superpowers:subagent-driven-development` is available in the
  session (checked only on Path A).

## Preconditions

- Implementer role only, inside an ai-whisper autonomous workflow (e.g. the
  SDD plan-execution phase).
- Never as the reviewer; never for ad-hoc edits outside a workflow.

## Procedure

### Step 0 — fan-out decision

Read the plan once; extract every task with its full text. Then:

- **Default: fan out** (Path A below, or its built-in fallback).
- **Inline escape — only if** the plan has ≤2 tasks, OR is purely mechanical
  single-concern work (one repetitive transformation, e.g. a rename or
  codemod sweep). Inline execution still follows the plan task-by-task with
  per-task verification.
- Whichever branch you take, your handback MUST name the execution mode (see
  Output).

### Path A — your harness supports subagent dispatch (e.g. Claude Code)

1. **If `superpowers:subagent-driven-development` is available in your
   session, you MUST invoke it** and follow its per-task loop: fresh
   implementer subagent per task → spec-compliance review → code-quality
   review, with fix-and-re-review loops. Skipping it to "just execute
   directly" is a contract violation, not a judgment call. Known
   rationalizations, pre-refuted:
   - "It pauses for humans" — false: continuous execution between tasks is
     built into that skill.
   - "Its endgame doesn't fit the workflow" — the workflow overrides below
     resolve every misfit.
2. **Workflow overrides** (apply while inside an ai-whisper workflow):
   - "Escalate to the human" (BLOCKED because the plan itself is wrong) →
     hand back that you CANNOT PROCEED and why; the workflow escalation path
     handles it.
   - `superpowers:finishing-a-development-branch` → do not use; the workflow
     handback replaces it. Merging is the operator's decision.
   - "Never start implementation on main/master without consent" → the
     collab-mounted workspace/branch is operator-provided; mounting is that
     consent.
3. **Fallback — built-in minimal protocol** (ONLY when
   subagent-driven-development is not available; it mimics the same loop).
   For each task, sequentially:
   1. Dispatch a fresh implementer subagent carrying the full task text plus
      scene-setting context. Never make a subagent read the plan file.
   2. Dispatch a spec-compliance reviewer subagent, then a code-quality
      reviewer subagent; loop fixes until both approve.
   3. Never dispatch implementation subagents in parallel.
4. **Model allocation** (applies to subagent dispatch under either protocol;
   your own model is fixed by the mount). Use model aliases (haiku / sonnet
   / opus), never versioned model names:

| Subagent role | Default | Flip condition |
| --- | --- | --- |
| Task implementer | sonnet | ↑ strongest tier if ambiguous / novel / cross-cutting / security-sensitive |
| Reviewer (spec or quality) | strongest available (opus or better) | never below the task implementer's tier |
| Mechanical / codemod | haiku | ↑ sonnet if it touches shared types or public API |
| Test-writer | sonnet | ↑ strongest tier for adversarial/repro tests; never haiku |
| Verification runner | haiku | ↑ sonnet if it must diagnose failures, not just report them |

Invariants: **reviewer tier ≥ implementer tier, always.** On the **2nd
failed review of the same task**, bump the task implementer one tier and
pass the failure history into the new dispatch.

### Path B — no subagent dispatch (e.g. Codex, ezio, agy)

Execute the plan inline: task-by-task in plan order, run per-task
verification, commit as the plan specifies, and hand back per the workflow
prompt with the mode line `Execution mode: inline (no subagent dispatch)`.
Path A does not apply to you — nothing in this skill blocks or changes your
handback.

### Failure handling

- A subagent dies or hangs → retry once; then do that task inline at your
  own tier and disclose it in the handback.
- 2nd failed review of the same task → tier escalation per the model table.
- Plan unreadable or not task-shaped → execute inline with disclosure; never
  block the workflow on skill-internal structure.
- Verification red after all tasks → fix before handing back; never hand
  back red.

## Output

The workflow prompt is authoritative. Before handing back: all subagents
settled, verification green, work committed. Include the commit SHAs, the
verification output, the 1-2 sentence summary the workflow prompt demands,
and one line naming the execution mode:

- `Execution mode: subagent-driven (superpowers)`
- `Execution mode: subagent-driven (built-in protocol)`
- `Execution mode: inline (<reason>)`

## Examples

Input: the ai-whisper SDD workflow hands the implementer an approved 5-task
plan (migration, repository method, service method, API route, integration
tests) inside Claude Code, where `superpowers:subagent-driven-development`
is available.

The agent reads the plan once — 5 tasks, not ≤2, not purely mechanical — so
Step 0 selects fan-out. It invokes `subagent-driven-development`, dispatching
a fresh sonnet implementer subagent per task, then an opus-tier
spec-compliance reviewer and an opus-tier code-quality reviewer per task,
looping fixes until both approve. Task 3's review fails twice, so the agent
escalates that task's implementer to opus for the retry and carries the
failure history into the new dispatch.

Output: "5/5 tasks complete. Commits a1b2c3d..f9e8d7c. Verification:
`npm test` — 61 passed. Execution mode: subagent-driven (superpowers)."

Input: the same workflow hands the implementer an approved 3-task plan, but
the session is running in Codex, which has no subagent dispatch.

The agent reads the plan; Path A does not apply, so it executes Path B:
task-by-task in plan order, running per-task verification and committing
after each task, per the plan.

Output: "3/3 tasks complete inline. Commit 4c5d6e7. Verification: `pytest`
— 24 passed. Execution mode: inline (no subagent dispatch)."

## Anti-patterns

- Skipping `superpowers:subagent-driven-development` to "just execute
  directly" when it's available and the plan doesn't qualify for the inline
  escape — a contract violation, not a judgment call ("it pauses for
  humans" and "its endgame doesn't fit the workflow" are pre-refuted
  rationalizations, not outs).
- Using this skill outside the implementer role — as the reviewer, or for
  ad-hoc edits with no ai-whisper workflow behind them.
- Making a subagent read the plan file directly instead of carrying it the
  full task text plus scene-setting context.
- Dispatching implementation subagents in parallel.
- Assigning a reviewer a model tier below the task implementer's tier.
- Invoking `superpowers:finishing-a-development-branch` inside the
  workflow — the workflow handback replaces it; merging is the operator's
  decision.
- Blocking the workflow on skill-internal structure (an unreadable or
  non-task-shaped plan) instead of executing inline with disclosure.
- Handing back with verification red.
