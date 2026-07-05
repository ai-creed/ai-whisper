---
name: ai-whisper-plan-execution
description: Use when executing an approved implementation plan as the implementer inside an ai-whisper autonomous workflow (plan-execution phase). Structures HOW to execute — subagent fan-out with model allocation where the harness supports it, disciplined inline execution otherwise.
---

# ai-whisper-plan-execution

Structure HOW you execute an approved implementation plan inside an ai-whisper autonomous workflow. The workflow handoff prompt stays authoritative for WHAT to deliver and the handback contract; this skill only governs execution structure.

## Gating

- Implementer role only, inside an ai-whisper autonomous workflow (e.g. the SDD plan-execution phase).
- Never as the reviewer; never for ad-hoc edits outside a workflow.

## Step 0 — fan-out decision

Read the plan once; extract every task with its full text. Then:

- **Default: fan out** (Path A below, or its built-in fallback).
- **Inline escape — only if** the plan has ≤2 tasks, OR is purely mechanical single-concern work (one repetitive transformation, e.g. a rename or codemod sweep). Inline execution still follows the plan task-by-task with per-task verification.
- Whichever branch you take, your handback MUST name the execution mode (see Handback).

## Path A — your harness supports subagent dispatch (e.g. Claude Code)

1. **If `superpowers:subagent-driven-development` is available in your session, you MUST invoke it** and follow its per-task loop: fresh implementer subagent per task → spec-compliance review → code-quality review, with fix-and-re-review loops. Skipping it to "just execute directly" is a contract violation, not a judgment call. Known rationalizations, pre-refuted:
   - "It pauses for humans" — false: continuous execution between tasks is built into that skill.
   - "Its endgame doesn't fit the workflow" — the workflow overrides below resolve every misfit.
2. **Workflow overrides** (apply while inside an ai-whisper workflow):
   - "Escalate to the human" (BLOCKED because the plan itself is wrong) → hand back that you CANNOT PROCEED and why; the workflow escalation path handles it.
   - `superpowers:finishing-a-development-branch` → do not use; the workflow handback replaces it. Merging is the operator's decision.
   - "Never start implementation on main/master without consent" → the collab-mounted workspace/branch is operator-provided; mounting is that consent.
3. **Fallback — built-in minimal protocol** (ONLY when subagent-driven-development is not available; it mimics the same loop). For each task, sequentially:
   1. Dispatch a fresh implementer subagent carrying the full task text plus scene-setting context. Never make a subagent read the plan file.
   2. Dispatch a spec-compliance reviewer subagent, then a code-quality reviewer subagent; loop fixes until both approve.
   3. Never dispatch implementation subagents in parallel.
4. **Model allocation** (applies to subagent dispatch under either protocol; your own model is fixed by the mount). Use model aliases (haiku / sonnet / opus), never versioned model names:

| Subagent role | Default | Flip condition |
| --- | --- | --- |
| Task implementer | sonnet | ↑ strongest tier if ambiguous / novel / cross-cutting / security-sensitive |
| Reviewer (spec or quality) | strongest available (opus or better) | never below the task implementer's tier |
| Mechanical / codemod | haiku | ↑ sonnet if it touches shared types or public API |
| Test-writer | sonnet | ↑ strongest tier for adversarial/repro tests; never haiku |
| Verification runner | haiku | ↑ sonnet if it must diagnose failures, not just report them |

Invariants: **reviewer tier ≥ implementer tier, always.** On the **2nd failed review of the same task**, bump the task implementer one tier and pass the failure history into the new dispatch.

## Path B — no subagent dispatch (e.g. Codex, ezio, agy, Cursor)

Execute the plan inline: task-by-task in plan order, run per-task verification, commit as the plan specifies, and hand back per the workflow prompt with the mode line `Execution mode: inline (no subagent dispatch)`. Path A does not apply to you — nothing in this skill blocks or changes your handback.

## Handback (both paths)

The workflow prompt is authoritative. Before handing back: all subagents settled, verification green, work committed. Include the commit SHAs, the verification output, the 1-2 sentence summary the workflow prompt demands, and one line naming the execution mode:

- `Execution mode: subagent-driven (superpowers)`
- `Execution mode: subagent-driven (built-in protocol)`
- `Execution mode: inline (<reason>)`

## Failure handling

- A subagent dies or hangs → retry once; then do that task inline at your own tier and disclose it in the handback.
- 2nd failed review of the same task → tier escalation per the model table.
- Plan unreadable or not task-shaped → execute inline with disclosure; never block the workflow on skill-internal structure.
- Verification red after all tasks → fix before handing back; never hand back red.
