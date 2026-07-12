---
name: ai-whisper-sdd
description: Use when the user asks to run SDD / spec-driven-development on an approved spec file, in any phrasing ("run SDD on docs/spec.md", "sdd kickoff", "kick off spec-driven-development with <path>", "$aiw-sdd") or by this skill's name — applies the ai-whisper-workflow skill with workflow type spec-driven-development. Kickoff only; executing an existing plan is a different job.
version: 0.1.0
---

# ai-whisper-sdd

## Intent

A name-preserving alias. The pre-collapse kickoff skills became the
`ai-whisper-workflow` skill; this one keeps the `ai-whisper-sdd` picker name
alive and delegates to that skill with workflow type
`spec-driven-development`. It adds no behavior of its own.

## Inputs

- The approved spec file path (the workflow's `--spec` input). An
  `@`-prefixed form is accepted; strip the `@` before resolving.

## Preconditions

- The `ai-whisper-workflow` skill is installed alongside this one — it is the
  delegation target and owns the full procedure.
- Its preconditions apply unchanged: `whisper` CLI on PATH, a ready collab
  with two bound agents, a readable spec file.

## Procedure

1. Read the `ai-whisper-workflow` skill's SKILL.md — it is installed in the
   adjacent directory of the same skills root.
2. Apply it with workflow type `spec-driven-development` and the given spec
   path — file vetting, collab readiness, kickoff, and the one-line report
   all follow that skill verbatim.
3. Only if the delegation target is not installed, use the inline fallback:
   vet the spec path, gate on `whisper collab status --json`, then run:

   ```bash
   whisper workflow start --type=spec-driven-development --spec=<resolved-absolute-path>
   ```

   Report exactly one line — Workflow `<workflowId>` started. Track progress
   with `whisper collab dashboard`. — then stop.

## Output

Identical to ai-whisper-workflow's output contract: exactly one
workflow-started line on success, or the matching gate error verbatim, and
nothing more after kickoff.

## Examples

Input: the user says "run SDD on docs/specs/2026-07-12-auth-design.md".

The agent reads the ai-whisper-workflow skill and applies it with type
`spec-driven-development`; the spec is readable, the collab is ready, and the
kickoff succeeds.

Output: Workflow `wf_31ab9c` started. Track progress with `whisper collab dashboard`.

## Anti-patterns

- Re-implementing or paraphrasing the ai-whisper-workflow procedure here —
  this alias delegates; the target owns the procedure.
- Using this alias for any workflow type other than
  `spec-driven-development` — redirect bugfix, deliberation, or ralph asks to
  their own entry points instead of bending the type.
- Polling or narrating after kickoff — the delegation target's
  fire-and-forget contract applies unchanged.
