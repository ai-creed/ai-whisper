---
name: ai-whisper-deliberation
description: Use when the user reaches for the ai-whisper-deliberation skill by name or asks to run a deliberation / deliberate on a seed file or fuzzy idea — a name-preserving alias that applies the ai-whisper-workflow skill with workflow type deliberation.
version: 0.1.0
---

# ai-whisper-deliberation

## Intent

A name-preserving alias. The pre-collapse kickoff skills became the
`ai-whisper-workflow` skill; this one keeps the `ai-whisper-deliberation`
picker name alive and delegates to that skill with workflow type
`deliberation`. No behavior of its own.

## Inputs

- The seed file path (the workflow's `--spec` input): a free-form fuzzy idea,
  question, or problem statement — one line suffices, but it must be
  non-empty. An `@`-prefixed form is accepted; strip the `@` before
  resolving.

## Preconditions

- The `ai-whisper-workflow` skill is installed alongside this one — it is the
  delegation target and owns the full procedure, including the empty-seed
  refusal.
- Its preconditions apply unchanged: `whisper` CLI on PATH, a ready collab
  with two bound agents, a readable non-empty seed.

## Procedure

1. Read the `ai-whisper-workflow` skill's SKILL.md — it is installed in the
   adjacent directory of the same skills root.
2. Apply it with workflow type `deliberation` and the given seed path —
   vetting (including the non-empty seed check), collab readiness, kickoff,
   and the one-line report all follow that skill verbatim.
3. Only if the delegation target is not installed, use the inline fallback:
   vet the seed path and refuse an empty seed, gate on
   `whisper collab status --json`, then run:

   ```bash
   whisper workflow start --type=deliberation --spec=<resolved-absolute-path>
   ```

   Report exactly one line — Workflow `<workflowId>` started. Track progress
   with `whisper collab dashboard`. — then stop.

## Output

Identical to ai-whisper-workflow's output contract: exactly one
workflow-started line on success, or the matching gate error verbatim
(including the empty-seed refusal), and nothing more after kickoff.

## Examples

Input: the user says "run deliberation on docs/ideas/plugin-system.md".

The agent reads the ai-whisper-workflow skill and applies it with type
`deliberation`; the seed is readable and non-empty, the collab is ready, and
the kickoff succeeds.

Output: Workflow `wf_9a04b1` started. Track progress with `whisper collab dashboard`.

## Anti-patterns

- Re-implementing the ai-whisper-workflow procedure here — delegate; the
  target owns it.
- Bending this alias to another workflow type — SDD, bugfix, and ralph asks
  go to their own entry points.
- Starting a deliberation on an empty or whitespace-only seed — the target's
  refusal branch applies.
- Confusing this kickoff alias with `ai-whisper-deliberation-craft` — craft
  guides Explorer/Challenger work inside an already-running deliberation.
- Polling or narrating after kickoff — fire-and-forget applies unchanged.
