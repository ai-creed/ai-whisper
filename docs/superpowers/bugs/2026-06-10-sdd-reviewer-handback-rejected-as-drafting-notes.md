# SDD reviewer handback rejected as drafting notes — workflow halted

**Date:** 2026-06-10
**Status:** Open — capture only, not yet investigated
**Workflow:** `wf_7c20d5df8a0d45c0` (spec-driven-development)
**Collab:** `collab_20260610033648573_94078cbd` (workspace `/Users/vuphan/Dev/ai-cortex`)
**Roles:** implementer = claude, reviewer = ezio (ezio standing in for codex)
**Phase:** 0 `spec-refining` (phaseRun `wfp_03c0b5861fa340ac`, chain `relay_ch_7b83728d0af14fb5`), outcome `escalated`

## What happened

1. 03:39:59Z — workflow started on spec `/Users/vuphan/Dev/ai-cortex/docs/superpowers/specs/2026-06-10-capture-precision-and-type-taxonomy-design.md`.
2. Ezio (reviewer) produced a **first, fully well-formed review**: complete acceptance matrix (14 requirement rows with evidence and file:line refs), two substantive Fail findings, explicit "Not approved" verdict. The implementer received it, applied both fixes (ai-cortex commit `b7f6b72`), and handed back.
3. On the **next reviewer turn**, ezio's handback was rejected by the evaluator and the phase escalated → workflow `halted` at 03:47:59Z.

Halt reason (verbatim from `whisper workflow inspect`):

> The handbackText does not contain a substantive review; instead it appears to be incomplete drafting notes, meta-commentary about formatting requirements, and placeholder thinking (e.g., 'Let's draft', 'Maybe', '...', 'Need include'). No acceptance matrix with actual rows, no findings or approval verdict, and no actual evaluation of the spec deliverable against requirements. The reviewer cannot proceed without providing the required phase-review output.

## Why it's interesting

- The same reviewer produced a high-quality structured review minutes earlier in the same chain, so the prompt/format contract was demonstrably understood. The failure is in the second turn only.
- The leaked content shape ("Let's draft", "Maybe", "...", "Need include") looks like **internal reasoning/draft scratchpad emitted as the final handback** — i.e. the agent handed back its thinking instead of its answer, or the handback was captured before the final answer was composed.

## Hypotheses to check (unverified)

1. **Premature handback capture:** relay/idle detection grabbed the reviewer's output mid-composition (drafting notes are exactly what a captured-too-early turn looks like).
2. **Ezio second-turn state:** the re-review turn carries the full prior matrix + implementer handback in context; possible context/window pressure or a mode where ezio narrates planning before producing the matrix, with only the narration relayed.
3. **Handback extraction bug:** the broker extracted the wrong message/segment from the reviewer session as handbackText.

## Repro pointers

- `whisper workflow inspect wf_7c20d5df8a0d45c0` — full state as captured above.
- Reviewer was mounted as `ezio` in the ai-cortex collab on daemon 127.0.0.1:4500 (pid 46612 at the time).
- Sequence to reproduce: SDD workflow, reviewer returns Fail findings, implementer hands back fixes, observe the reviewer's *second* review turn.

## Impact

Workflow halts mid-phase and requires manual `whisper workflow resume`. No data loss; the implementer-side deliverable was unaffected.
