# ai-whisper Code Review Skill - Design

Date: 2026-06-04
Status: approved-for-planning

## Goal

Add an ai-whisper bundled skill, `ai-whisper-code-review`, that gives agents a
workflow-agnostic method for reviewing code written by agents. The skill is used
whenever an ai-whisper workflow asks for code review of implementation output,
regardless of which workflow produced that code.

The skill should preserve the useful behavior of Codex `/review`: findings
first, concrete file/line evidence, severity ordering, and focus on real bugs,
regressions, and missing critical tests. It adapts that behavior for autonomous
workflow use by keeping code-bearing review gates bounded and making clear which
code-quality issues are blocking.

## Motivation

ai-whisper workflows already have a general workflow review protocol. That
protocol is good at controlling autonomous gates: review modes, output shape,
non-blocking risks, and evaluator classification. It is not meant to be the
detailed code-review brain.

Code quality is a distinct concern at any code-bearing workflow review gate. The
reviewer needs guidance for how to evaluate code written by agents to accomplish
a task: plan implementation, bugfix, Ralph chunk, or future workflow output.
That guidance should live in a bundled ai-whisper skill so both Codex and Claude
can install and invoke it.

## Non-goals

- Replace the existing workflow review protocol.
- Add a Superpowers plugin skill.
- Create a separate workflow control verdict format.
- Review specs, plans, diagnoses, or post-mortems as prose artifacts.
- Block workflow progress on style, naming, optional refactors, or speculative
  architecture polish.
- Redesign `whisper skill install`.

## Design

### Skill Boundary

`ai-whisper-code-review` is a code-review guideline, not a workflow protocol.
It evaluates code written by agents to complete a task. The task may come from:

- SDD implementation output.
- Complex bug-fixing `fix-and-verify`.
- Ralph per-item code chunks.
- Ralph final acceptance when the goal produced code changes.
- Future workflow phases whose reviewed artifact is code.

The skill supplies the code-quality evaluation method: what to inspect, what
counts as blocking, how to judge tests, how to review fix rounds, and how to
avoid low-value nit loops.

The workflow handoff supplies the output protocol and evaluator semantics. If a
workflow handoff includes `WORKFLOW_REVIEW_PROTOCOL`, the skill must follow that
protocol exactly and must not define a conflicting output shape.

### Skill Location

The source skill lives under the existing CLI skill bundle:

```text
packages/cli/skills/ai-whisper-code-review/SKILL.md
```

Build output continues to be copied by the existing script:

```text
packages/cli/skills/* -> packages/cli/dist/skills/*
```

No new installer mode is required.

### Skill Frontmatter

```yaml
---
name: ai-whisper-code-review
description: Review agent-written code for ai-whisper workflows. Use when an ai-whisper workflow or user asks for code review of implementation output, bug fixes, committed changes, diff/commit ranges, Ralph code chunks, or final code-quality acceptance.
---
```

The description intentionally targets code review, not broad workflow review.

### Skill Body

The body should stay compact. It should not include references or scripts in the
first version.

Proposed structure:

```markdown
# ai-whisper-code-review

Review code written by an agent to accomplish a task. Focus on real
code-quality defects that could make the task unsafe, incomplete, or
unacceptable.

If this review is part of an ai-whisper workflow, the workflow handoff controls
the output format. Follow the handoff protocol exactly.

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
```

### Workflow Handoff Integration

Add a small prompt fragment that asks the reviewer to use the skill without
replacing the workflow protocol:

```text
Use the ai-whisper-code-review skill to evaluate the delivered code. The workflow
review protocol below controls your output format and evaluator semantics; the
skill controls how you inspect code and decide which code-quality issues are
blocking.
```

This text should appear before `WORKFLOW_REVIEW_PROTOCOL` in code-bearing review
handoffs.

Apply it to review phases whose reviewed artifact is code:

- SDD `code-review`.
- Complex bug-fixing `fix-and-verify`.
- Ralph per-item review, because a chunk may include code.
- Ralph final acceptance review, because a completed goal may include code.
- Future workflow review phases whose artifact is implementation code, typically
  commit ranges.

Do not apply it to non-code reviews:

- SDD spec refining.
- SDD plan review.
- Complex bug-fixing diagnosis review.
- Complex bug-fixing post-mortem review.
- Any prose/artifact review where code quality is not the review target.

The handoff and skill must not contradict each other:

- The skill controls code-review criteria.
- `WORKFLOW_REVIEW_PROTOCOL` controls output structure.
- `REVIEW_SYSTEM_PROMPT` remains responsible for classifying reviewer handback
  text into workflow control verdicts.
- The reviewer must not emit workflow control labels as its own output format.

### Evaluator Compatibility

Current evaluator behavior depends on the handoff protocol shape:

- Review text is classified by `REVIEW_SYSTEM_PROMPT`.
- `Non-blocking risks:` is treated as informational only.
- `separateReviewSections()` strips the trailing `Non-blocking risks:` block
  before review classification and before forwarding findings to the
  implementer.
- A blocking, fixable code defect belongs under `Findings:` so the workflow loops
  back for a fix.
- A genuine inability to review uses cannot-proceed wording so the evaluator can
  classify escalation.

Therefore the code-review skill must not define a new section order or final
decision line. It only tells the reviewer how to determine whether code issues
are blocking.

### Installation

`whisper skill install` already copies every bundled skill directory from the
built skill tree into both agent homes by default:

- `~/.claude/skills/`
- `~/.codex/skills/`

Adding `packages/cli/skills/ai-whisper-code-review/SKILL.md` is sufficient for
normal install behavior. The existing `--target` and `--force` behavior remains
unchanged.

README's required-skills section should mention that `ai-whisper-code-review` is
installed with the workflow kickoff skills and is used by workflow code-review
handoffs.

## Testing

Add guard tests for the skill content:

- Source skill exists at
  `packages/cli/skills/ai-whisper-code-review/SKILL.md`.
- Frontmatter has `name: ai-whisper-code-review`.
- Description mentions code review and workflow code artifacts.
- Body says workflow handoff controls output format.
- Body says not to emit workflow control labels.
- Body names `Findings:` and trailing `Non-blocking risks:`.

Add workflow prompt tests:

- Code-bearing review prompts contain `ai-whisper-code-review`.
- Non-code review prompts do not contain `ai-whisper-code-review`.
- Code-bearing review prompts still contain `WORKFLOW_REVIEW_PROTOCOL`.
- The skill-guidance text says the protocol controls output format and evaluator
  semantics.
- Fixtures that exercise evaluator compatibility must render or derive from the
  real prompt/protocol text, not from a convenient hand-built ordering. In
  particular, tests must preserve the specified section order: verdict line
  before the trailing `Non-blocking risks:` block.
- Keep the existing structural invariant that the protocol's verdict line
  appears before the final `Non-blocking risks:` section, because
  `separateReviewSections()` strips that trailing section before classification.

Add install/build tests:

- Built skill tree contains `ai-whisper-code-review` after `pnpm build`.
- `runSkillInstall` installs `ai-whisper-code-review` into both Claude and Codex
  fake homes.
- README smoke test includes the skill in the required-skills section.

## Success Criteria

- ai-whisper ships a bundled `ai-whisper-code-review` skill.
- Workflow code-review handoffs request that skill while preserving the existing
  handoff protocol.
- Reviewer output remains evaluator-compatible.
- Existing workflow review protocol remains authoritative for output shape.
- Installation behavior remains a simple `whisper skill install`.
