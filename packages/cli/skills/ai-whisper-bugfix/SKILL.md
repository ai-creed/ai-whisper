---
name: ai-whisper-bugfix
description: Use when the user reaches for the ai-whisper-bugfix skill by name or asks to run bugfix / complex-bug-fixing on a bug report file — a name-preserving alias that applies the ai-whisper-workflow skill with workflow type complex-bug-fixing.
version: 0.1.0
---

# ai-whisper-bugfix

## Intent

A name-preserving alias. The pre-collapse kickoff skills became the
`ai-whisper-workflow` skill; this one keeps the `ai-whisper-bugfix` picker
name alive and delegates to that skill with workflow type
`complex-bug-fixing`. No behavior of its own.

## Inputs

- The bug report file path (the workflow's `--spec` input): symptoms,
  reproduction steps, expected-vs-actual — not a spec or open-ended goal. An
  `@`-prefixed form is accepted; strip the `@` before resolving.

## Preconditions

- The `ai-whisper-workflow` skill is installed alongside this one — it is the
  delegation target and owns the full procedure.
- Its preconditions apply unchanged: `whisper` CLI on PATH, a ready collab
  with two bound agents, a readable bug report.

## Procedure

1. Read the `ai-whisper-workflow` skill's SKILL.md — it is installed in the
   adjacent directory of the same skills root.
2. Apply it with workflow type `complex-bug-fixing` and the given bug-report
   path — vetting, collab readiness, kickoff, and the one-line report all
   follow that skill verbatim.
3. Only if the delegation target is not installed, use the inline fallback:
   vet the bug-report path, gate on `whisper collab status --json`, then run:

   ```bash
   whisper workflow start --type=complex-bug-fixing --spec=<resolved-absolute-path>
   ```

   Report exactly one line — Workflow `<workflowId>` started. Track progress
   with `whisper collab dashboard`. — then stop.

## Output

Identical to ai-whisper-workflow's output contract: exactly one
workflow-started line on success, or the matching gate error verbatim, and
nothing more after kickoff.

## Examples

Input: the user says "run bugfix on docs/reports/login-crash.md".

The agent reads the ai-whisper-workflow skill and applies it with type
`complex-bug-fixing`; the report is readable, the collab is ready, and the
kickoff succeeds.

Output: Workflow `wf_58c2de` started. Track progress with `whisper collab dashboard`.

## Anti-patterns

- Re-implementing the ai-whisper-workflow procedure here — delegate; the
  target owns it.
- Bending this alias to another workflow type — SDD, deliberation, and ralph
  asks go to their own entry points.
- Fixing the bug directly when the user handed you a bug-report file for the
  workflow — kickoff is the ask; the workflow's implementer does the fixing.
- Polling or narrating after kickoff — fire-and-forget applies unchanged.
