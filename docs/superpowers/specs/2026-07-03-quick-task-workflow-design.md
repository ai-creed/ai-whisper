# Quick Task Workflow — design

Status: design settled, not yet implemented
Date: 2026-07-03

## Summary

A new workflow type `quick-task`: the lightweight sibling of spec-driven-development for small, pre-scoped tasks. The human approves the approach in chat *before* kickoff — the workflow itself runs a single implement → acceptance-review loop, with no spec-refining or plan-writing phases. A hard, deterministic scope gate at `whisper workflow start` refuses any task brief that does not declare a small blast radius, so oversized tasks cannot even kick off.

This has been the most common real-world use case besides SDD: scope is small enough that a dedicated approach, presented and approved in conversation, is good to go without a formal spec.

## Positioning

| Workflow | Covers | Ceremony |
|---|---|---|
| deliberation | pre-spec exploration — what should we even do? | high |
| spec-driven-development | real features — spec → plan → code → review | high |
| complex-bug-fixing | unknown-cause bugs — diagnosis-gated fixing | high |
| ralph-loop | open-ended goals — chunked grind loop | medium |
| **quick-task** (new) | **known-scope small change — build it, review it** | **minimal** |

The distinguishing axis is task size, not pairing (every workflow here is a pair). The scope gate is what keeps "quick" honest.

## Flow

1. The operator discusses the task with the implementer agent in chat and approves the approach there. **Human approval pre-kickoff is the only approach gate** — the workflow contains no reviewer pass on the approach itself.
2. The implementer invokes the `ai-whisper-quick-task` kickoff skill, which:
   - writes the task brief (if not already written) from the approved discussion, in the exact required format;
   - runs the same collab-readiness checks as the other kickoff skills;
   - runs `whisper workflow start --type=quick-task --spec=<brief path>`.
3. The **hard scope gate** validates the brief content at start. Violations abort kickoff with an actionable error; no workflow row is created.
4. The single workflow phase runs: implementer implements + commits → reviewer acceptance-reviews the commit range against the brief → findings loop back as fix rounds (max 5).
5. The run completes, or halts back to the human (scope explosion, round exhaustion, or escalation).

## Task brief contract

Location convention: `.ai-whisper/tasks/<YYYY-MM-DD>-<slug>.md`, gitignored like the ralph/bugfix run dirs. Small tasks leave no doc clutter; the commits are the durable record. Any readable path is accepted by `--spec` — the location is a skill convention, not a gate rule.

Required sections (the gate enforces presence + non-empty body for each):

```markdown
# Task: <short title>

## Task
<what + why, 2–5 lines>

## Approved approach
<the approach the human ratified in chat — implementer must not redesign it>

## Scope
- `path/to/file-a.ts`
- `path/to/file-b.ts`
- `test/file-a.test.ts`

## Acceptance checks
- <how the reviewer verifies: commands to run, expected behavior>
```

The `## Scope` bullet list is the declared blast radius: every file the task is expected to touch. It is simultaneously (a) the gate's input, (b) the implementer's mid-flight contract, and (c) a review criterion.

## Hard scope gate

### Enforcement point

A pure function `validateTaskBrief(content: string)` in a new broker module (`packages/broker/src/runtime/task-brief.ts`, exported from the package index), wired into `runWorkflowStart` (`packages/cli/src/commands/workflow/start.ts`) for `workflowType === "quick-task"` only. The CLI reads the brief file (reader injected for tests) and refuses to call `createWorkflow` on violations. This follows the existing evaluator-preflight precedent in the same function: fail fast at start with an actionable message, before anything persists.

### Rules (deterministic)

1. **Required sections** — `## Task`, `## Approved approach`, `## Scope`, `## Acceptance checks` must each be present with non-empty body content. Heading match is case-insensitive and accepts `##` or `###`.
2. **Scope list** — `## Scope` must contain at least one top-level bullet (`-` or `*`); each bullet declares one file path (backticked or plain — the first token is taken).
3. **Non-test file cap** — declared **non-test** files must number **≤ 5** (`QUICK_TASK_SCOPE_CAP = 5`). A path is a test file when it has a `test/`, `tests/`, or `__tests__/` segment, or its basename contains `.test.` / `.spec.` / ends with `_test.<ext>`. Test files are uncounted, so a small task plus its tests passes.
4. **No escape hatch** — no override flag, no env knob. If the gate trips, split the task or use spec-driven-development. The error message says exactly that and names every violation (missing section names, the over-cap count vs the cap).

The cap starts deliberately eased at 5 for the first dogfood runs; the intent is to tune the constant (likely downward, toward the operator's own ">3 files → break it down" rule) once real usage shows where legitimate quick tasks land. Tuning means changing the constant — not adding an override flag.

### Leniency (to absorb agent diversity)

Strict only on the contract above. Case-insensitive headings, `##`/`###` both accepted, extra sections ignored, plain or backticked paths both parse, surrounding prose in `## Scope` ignored (only bullets count). Multiple violations are all reported at once so a wrongly-formatted brief converges in one retry.

### What the gate cannot check

Qualitative "not executable right away" signals (needs research, unsettled design, migration risk) are covered by two soft layers behind the hard gate:

- **Kickoff-skill pre-check** — the skill instructs the invoking agent to refuse kickoff and recommend spec-driven-development or deliberation when the task smells like design work rather than execution.
- **Mid-flight scope guard** — the implement template instructs the implementer to hand back CANNOT PROCEED (halting the run to the human) when the actual work exceeds the declared scope materially, instead of pushing through.

## Workflow definition

Registered in `packages/broker/src/runtime/workflow-registry.ts` alongside the existing four, wrapped by `withOperatorControl` like all of them. Purely declarative — no driver, schema, or evaluator changes.

```
type: "quick-task"
displayName: "Quick Task"
description: "Human-approved task brief → implement → acceptance review, hard-gated to small pre-scoped tasks"
defaultImplementer: claude, defaultReviewer: codex
```

Single phase `implement-and-review` (shape borrowed from complex-bug-fixing's `fix-and-verify`):

```
implementerRole: "implementer", reviewerRole: "reviewer"
maxRounds: 5                       // a "small task" needing >5 fix rounds means the premise was wrong; halting is correct
initialHandoffStep: "implement"
stepTemplates: { implement, review, fix }
reviewMode: "acceptance-review"
evaluatorPromptKey: "review-loop"
artifactOut: { kind: "commit-range" }
anchorCommitBaseOnEntry: true      // anchors the commit range at phase entry (no separate execute phase)
renderFixTemplateOnFindings: true
```

### Templates

**Implement (kickoff)** — key clauses, composed with the standard autonomous-workflow boilerplate (never ask for confirmation; handback ≥ two sentences, well over 100 characters):

- Read the task brief at `{specPath}`. It was written after a human approved the approach — treat it as the ratified contract: implement the `## Approved approach` as written; do NOT redesign it.
- The files under `## Scope` are the declared blast radius. Implement, add/adjust tests, run the project's verification command and ensure it passes, then commit (never commit the brief; `.ai-whisper/` is gitignored).
- Scope guard: if the work is materially bigger than the brief — non-test files needed beyond the `## Scope` list, the approach does not survive contact with the code, or a hidden dependency/migration appears — do NOT push through. Hand back that you CANNOT PROCEED, naming what exploded; the run halts to the human, who re-scopes or escalates to spec-driven-development.
- Hand back the commit SHAs and the verification output, plus a 1–2 sentence summary.

**Review** — acceptance-review of `{commitRange}` (live-HEAD wording reused from SDD_CODE_REVIEW), verifying against the brief's `## Acceptance checks`, with `CODE_REVIEW_SKILL_GUIDANCE` + `WORKFLOW_REVIEW_PROTOCOL` appended. One quick-task-specific criterion: touching non-test files beyond the brief's `## Scope` list is a blocking finding — the implementer should have halted instead.

**Fix** — the standard apply-findings template (mirrors SDD code-review fix): amend or add commits, hand back updated SHAs + verification output.

## Kickoff skill: `ai-whisper-quick-task`

New bundled skill at `packages/cli/skills/ai-whisper-quick-task/SKILL.md`, mirroring the sdd/bugfix skill structure (readiness checks, fire-and-forget contract, duo-roleplay section, pause/resume/cancel sections). Trigger phrases: "run quick task …", "kick off quick-task …", `/aiw-quick-task`, `$aiw-quick-task`.

One structural difference from sdd/bugfix (where the seed artifact pre-exists): **brief-writing is part of the kickoff flow.** Steps:

1. **Executability pre-check** — before writing anything: if the task needs research, unsettled design decisions, or schema/contract migrations, refuse and recommend spec-driven-development (or deliberation); this workflow is for tasks executable right away. If the approach was never explicitly approved by the user in this conversation, ask ONCE for approval before proceeding.
2. **Write or resolve the brief** — if the user gave a path, verify it is readable. Otherwise write the brief from the approved discussion to `.ai-whisper/tasks/<date>-<slug>.md` (create the directory), using the exact embedded template (the four required headings + scope bullet list). The skill embeds the template verbatim so agent output diversity cannot produce a gate-failing format.
3. **Collab readiness** — identical checks to the sdd skill (daemon active, exactly two agents bound, recovery normal, evaluator not misconfigured).
4. **Start** — `whisper workflow start --type=quick-task --spec=<brief path>`. If the scope gate rejects, relay the violations to the user verbatim and stop — do NOT silently rewrite the scope list to squeeze under the cap; the user decides whether to split or escalate.
5. **Report one line and exit** (fire-and-forget, same idle-detection rationale as the other kickoff skills).

No separate brief-writing skill: per the standing decision (mem-2026-05-27), guidance rides existing kickoff skills — a new thin standalone skill adds surface and drift risk without behavior.

## Deliverables

| File | Change |
|---|---|
| `packages/broker/src/runtime/task-brief.ts` | new — `validateTaskBrief`, scope parser, `QUICK_TASK_SCOPE_CAP` |
| `packages/broker/src/runtime/workflow-registry.ts` | `QUICK_TASK` definition + templates + registry entry |
| `packages/broker/src/index.ts` | export `validateTaskBrief` + `QUICK_TASK_SCOPE_CAP` (registry exports already flow through here) |
| `packages/cli/src/commands/workflow/start.ts` | gate wiring for `quick-task` (injected brief reader; default `node:fs` reader in command wiring) |
| `packages/cli/skills/ai-whisper-quick-task/SKILL.md` | new kickoff skill |
| `docs/workflows.md` | new Quick Task section (flow, brief format, gate rules) |
| `test/task-brief.test.ts` | new — gate unit tests |
| `test/quick-task-skill.test.ts` | new — bundled-skill copy/content test (mirrors ralph/bugfix skill tests) |
| existing registry/start/control tests | quick-task cases |

## Testing

- **Gate unit tests** (pure function): happy path; each missing/empty section; empty scope list; over-cap (6 non-test files); test-file exclusion (5 source + N test files passes); heading leniency (`###`, case); backticked vs plain paths; multiple violations reported together.
- **Start wiring**: `runWorkflowStart` with `quick-task` + invalid brief throws listing violations and never calls `createWorkflow`; valid brief creates the workflow; other workflow types never read the brief file.
- **Registry invariants**: `listWorkflowTypes()` includes `quick-task`; definition shape (single phase, acceptance-review, `anchorCommitBaseOnEntry`, maxRounds 5); operator-control fragment appended.
- **Control test**: a quick-task run kicks off with the rendered implement handoff (brief path substituted) and routes implement → review through the existing driver, mirroring the bugfix control test.
- **Skill test**: skill directory bundled by the build's copy-skills step; content includes the brief template headings and the `--type=quick-task` start command.

## Non-goals

- No override flag or env knob for the scope gate (hard means hard).
- No reviewer gate on the approach — human approval pre-kickoff is the approach gate.
- No new CLI subcommands (no `brief-template` generator; the template lives in the skill and the gate errors name the expected format).
- No driver, evaluator, broker-schema, or dashboard changes.
- No committed-brief convention (ephemeral by design; a future flag could opt into a committed location if friction appears).

## Acceptance criteria

1. `whisper workflow types` lists `quick-task`.
2. Starting with a valid brief creates the workflow; the first handoff is the rendered implement template with the brief path.
3. Starting with a brief missing any required section, or declaring more than 5 non-test files, exits with an error naming every violation and the split-or-use-sdd remedy; no workflow row is created.
4. Test-file paths do not count toward the cap.
5. The bundled skill ships in the npm package (build copy-skills) and contains the embedded brief template.
6. A happy-path run completes implement → acceptance review → workflow complete on the existing driver with no driver changes.
7. Root gates pass: `pnpm lint`, root `pnpm typecheck`, `pnpm test`, `pnpm build`.
