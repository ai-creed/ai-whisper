---
name: ai-whisper-code-review
description: Review agent-written code for ai-whisper workflows. Use when an ai-whisper workflow or user asks for code review of implementation output, bug fixes, committed changes, diff/commit ranges, Ralph code chunks, or final code-quality acceptance.
---

# ai-whisper-code-review

Review code written by an agent to accomplish a task. Focus on real
code-quality defects that could make the task unsafe, incomplete, or
unacceptable.

If this review is part of an ai-whisper workflow, the workflow handoff controls the output format. Follow the handoff protocol exactly.

## Scope

Review the delivered code and directly affected behavior against the task
artifact: spec, plan, bug report, goal, diagnosis, prior findings, or acceptance
criteria.

Do not review workflow protocol quality, spec prose, plan prose, or architecture
polish unless the issue causes a concrete code failure.

## What Counts As Blocking

Report a blocking finding only when it is concrete and fixable, with file/line
or command evidence, and it affects one of:

- required behavior or acceptance criteria
- existing behavior regression
- data loss, persistence corruption, or wrong state transition
- race, retry, recovery, lifecycle, or stuck-workflow failure
- security, permissions, or unsafe command execution
- CLI/runtime behavior visible to users
- test required by the task but missing, misplaced, or checking the wrong
  condition/layer
- bugfix where the root cause is not actually removed or the reproduction is not
  truly green

Do not block on style, naming, formatting, optional refactors, speculative future
concerns, or merely "nice to have" tests.

## Review Procedure

1. Read the task artifact and delivered diff/commit range.
2. Inspect surrounding code enough to understand behavior.
3. Inspect committed tests when the task requires tests or the risk needs
   regression coverage.
4. Run targeted verification when feasible.
5. Do one adversarial pass: assume the code is subtly wrong and look for the
   highest-impact failure.
6. Keep only findings that meet the blocking standard.

Passing tests are supporting evidence, not proof. A green suite does not excuse
a test that checks the wrong layer or misses the required condition.

## Fix Review

When reviewing a fix for prior findings, focus on:

- whether the prior finding is actually fixed
- whether the new/changed test would have failed before the fix
- whether the fix introduces an obvious nearby blocker

Do not reopen broad review unless the fix changes the broader surface.

## Output

When invoked by an ai-whisper workflow, obey the workflow handoff's output format
exactly.

In particular:
- Keep the review matrix if the handoff protocol requires it.
- Put blocking code issues under `Findings:`.
- Omit `Findings:` entirely when there are no blocking findings.
- Put the approval or cannot-proceed line where the handoff protocol requires
  it.
- Keep `Non-blocking risks:` as the final section.
- Do not emit workflow control labels such as `approve`, `findings`, or
  `escalate`.
