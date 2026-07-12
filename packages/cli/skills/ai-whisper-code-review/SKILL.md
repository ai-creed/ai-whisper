---
name: ai-whisper-code-review
description: Use when an ai-whisper workflow or user asks to review agent-written code — implementation output, bug fixes, committed changes, diff/commit ranges, Ralph code chunks, or a final code-quality acceptance gate — reviews the diff against the task artifact and reports only blocking findings, in the workflow handoff's required output format when one applies.
version: 0.1.0
---

# ai-whisper-code-review

## Intent

Review code written by an agent to accomplish a task. Focus on real
code-quality defects that could make the task unsafe, incomplete, or
unacceptable. Review the delivered code and directly affected behavior
against the task artifact: spec, plan, bug report, goal, diagnosis, prior
findings, or acceptance criteria.

Do not review workflow protocol quality, spec prose, plan prose, or
architecture polish unless the issue causes a concrete code failure.

## Inputs

- The delivered diff or commit range to review.
- The task artifact to check it against: spec, plan, bug report, goal,
  diagnosis, prior findings, or acceptance criteria.
- When reviewing a fix for prior findings: the prior findings themselves.
- When invoked from an ai-whisper workflow: the workflow handoff, which
  controls the required output format.

## Preconditions

- A task artifact exists to review the diff against. Without one — a spec,
  plan, bug report, goal, diagnosis, prior findings, or acceptance criteria
  — there is no standard to check the code against.
- The delivered diff or commit range is available to inspect.
- If this review is part of an ai-whisper workflow, the workflow handoff
  controls the output format — follow the handoff protocol exactly.

## Procedure

1. Read the task artifact and delivered diff/commit range.
2. Inspect surrounding code enough to understand behavior.
3. Inspect committed tests when the task requires tests or the risk needs
   regression coverage.
4. Run targeted verification when feasible.
5. Do one adversarial pass: assume the code is subtly wrong and look for the
   highest-impact failure.
6. Keep only findings that meet the blocking standard below.

Passing tests are supporting evidence, not proof. A green suite does not
excuse a test that checks the wrong layer or misses the required condition.

### What counts as blocking

Report a blocking finding only when it is concrete and fixable, with
file/line or command evidence, and it affects one of:

- required behavior or acceptance criteria
- existing behavior regression
- data loss, persistence corruption, or wrong state transition
- race, retry, recovery, lifecycle, or stuck-workflow failure
- security, permissions, or unsafe command execution
- CLI/runtime behavior visible to users
- test required by the task but missing, misplaced, or checking the wrong
  condition/layer
- bugfix where the root cause is not actually removed or the reproduction is
  not truly green

Do not block on style, naming, formatting, optional refactors, speculative
future concerns, or merely "nice to have" tests.

### Fix review

When reviewing a fix for prior findings, focus on:

- whether the prior finding is actually fixed
- whether the new/changed test would have failed before the fix
- whether the fix introduces an obvious nearby blocker

Do not reopen broad review unless the fix changes the broader surface.

## Output

When invoked by an ai-whisper workflow, obey the workflow handoff's output
format exactly.

In particular:
- Keep the review matrix if the handoff protocol requires it.
- Put blocking code issues under `Findings:`.
- Omit `Findings:` entirely when there are no blocking findings.
- Put the approval or cannot-proceed line where the handoff protocol requires
  it.
- Keep `Non-blocking risks:` as the final section.
- Do not emit workflow control labels such as `approve`, `findings`, or
  `escalate`.

## Examples

Input: an ai-whisper bugfix workflow hands this skill a diff and the bug
report it must satisfy. Bug report: "parser throws on empty input; add a
guard and a regression test." Diff: `src/parser.ts` adds `if (!input) return
[];` at the top of `parse()`, and adds a test `parses empty input without
throwing` that calls `parse("")` and asserts it returns `[]` without
throwing.

The agent reads the bug report and diff, confirms the guard removes the
reported crash path, and inspects the new test: it calls `parse("")` and
would have thrown before the guard was added, so it is a real regression
test for this bug. One unrelated observation surfaces — `parse` still
accepts `undefined` silently — but it is not required behavior, not a
regression, and not requested by the bug report, so it is non-blocking.

Output (matching the workflow handoff's required format):

```
Findings: none

Non-blocking risks:
- `parse` still accepts `undefined` silently with no guard; consider
  explicit validation in a follow-up.

The reported crash is gone and the new test would have failed before this
fix, so the fix is sound and the task can proceed.
```

## Anti-patterns

- Reviewing workflow protocol quality, spec prose, plan prose, or
  architecture polish when the issue does not cause a concrete code failure.
- Blocking on style, naming, formatting, optional refactors, speculative
  future concerns, or merely "nice to have" tests.
- Treating a green test suite as proof instead of supporting evidence — a
  passing suite does not excuse a test that checks the wrong layer or misses
  the required condition.
- Reopening a full review of a fix when the fix did not change the broader
  surface — fix review stays scoped to the prior findings.
- Emitting workflow control labels such as `approve`, `findings`, or
  `escalate` instead of following the handoff protocol's actual format.
- Reviewing a diff with no task artifact to check it against — there is no
  standard to hold the code to.
