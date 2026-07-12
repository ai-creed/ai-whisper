---
name: ai-whisper-ralph
description: Use when the user asks to run ralph or a ralph loop on an open-ended goal file, in any phrasing ("run ralph on docs/GOAL.md", "kick off ralph with <path>", "grind this goal file with ralph", "$aiw-ralph") or by this skill's name — applies the ai-whisper-workflow skill with workflow type ralph-loop to start the loop. Not for authoring goal files or explaining what ralph is.
version: 0.1.0
---

# ai-whisper-ralph

## Intent

A name-preserving alias. The pre-collapse kickoff skills became the
`ai-whisper-workflow` skill; this one keeps the `ai-whisper-ralph` picker
name alive and delegates to that skill with workflow type `ralph-loop`. No
behavior of its own.

## Inputs

- The goal file path (the workflow's `--spec` input): an open-ended goal or
  checklist (e.g. `GOAL.md`), not a formal spec — per-chunk conventions the
  user wants followed belong inside the goal file itself. An `@`-prefixed
  form is accepted; strip the `@` before resolving.

## Preconditions

- The `ai-whisper-workflow` skill is installed alongside this one — it is the
  delegation target and owns the full procedure.
- Its preconditions apply unchanged: `whisper` CLI on PATH, a ready collab
  with two bound agents, a readable goal file.

## Procedure

1. Read the `ai-whisper-workflow` skill's SKILL.md — it is installed in the
   adjacent directory of the same skills root.
2. Apply it with workflow type `ralph-loop` and the given goal path —
   vetting, collab readiness, kickoff, and the one-line report all follow
   that skill verbatim.
3. Only if the delegation target is not installed, use the inline fallback:
   vet the goal path, gate on `whisper collab status --json`, then run:

   ```bash
   whisper workflow start --type=ralph-loop --spec=<resolved-absolute-path>
   ```

   Report exactly one line — Workflow `<workflowId>` started. Track progress
   with `whisper collab dashboard`. — then stop.

## Output

Identical to ai-whisper-workflow's output contract: exactly one
workflow-started line on success, or the matching gate error verbatim, and
nothing more after kickoff.

## Examples

Input: the user says "kick off ralph with docs/GOAL.md".

The agent reads the ai-whisper-workflow skill and applies it with type
`ralph-loop`; the goal file is readable, the collab is ready, and the kickoff
succeeds.

Output: Workflow `wf_c7e310` started. Track progress with `whisper collab dashboard`.

## Anti-patterns

- Re-implementing the ai-whisper-workflow procedure here — delegate; the
  target owns it.
- Bending this alias to another workflow type — SDD, bugfix, and deliberation
  asks go to their own entry points.
- Grinding the goal yourself instead of kicking off the loop — the ralph
  workflow's implementer does the chunk-by-chunk work.
- Polling or narrating after kickoff — fire-and-forget applies unchanged.
