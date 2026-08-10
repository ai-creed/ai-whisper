# Read Fan-Out Guidance for Deliberation, Code-Review, and Bug Diagnosis — Design

**Date:** 2026-08-10
**Status:** Approved design (brainstormed in session `research-loop-graph-engineering-vs-whisper`)
**Origin:** Recommendation §8.1 of the research report *Loop Engineering, Graph Engineering, and ai-whisper* (canonical copy in `~/.ai-pref-nsync/local-docs/ai-whisper/knowledge-references/2026-07-29-loop-graph-engineering-vs-ai-whisper.md`; gitignored mirror under `docs/superpowers/internal/`).

## Problem

ai-whisper serializes everything through the single baton — deliberately, and correctly, for work that *writes*. But three phases are dominated by read-only breadth work, where the field's strongest evidence (Anthropic's orchestrator-worker research results; the read/write reconciliation of the multi-agent debate) says parallel fan-out is safe and materially faster and broader:

1. **Deliberation** — the Explorer's per-layer research (survey the space, triangulate sources).
2. **Code review** — the reviewer's breadth reads before findings (diff sweep, artifact cross-check, adjacent-module reads).
3. **Complex-bug-fixing diagnosis** — the implementer's repro-context reads and blast-radius enumeration.

Today no guidance tells the agent it may fan these reads out to its harness's own subagents. The `ai-whisper-plan-execution` skill already prescribes subagent fan-out for *execution structure* (and explicitly forbids parallel implementation subagents); nothing analogous exists for read-heavy phases.

## Design

### The rule (one canonical fragment)

Add one exported constant to `packages/broker/src/runtime/workflow-registry.ts` (name: `WORKFLOW_READ_FANOUT_GUIDANCE`), ~5 lines of prose, stating in substance:

> If your harness supports dispatching subagents (e.g. Claude Code), fan read-only work — research sweeps, file reads, blast-radius enumeration — out to parallel subagents and synthesize the results yourself before handing back. Anything that writes (files, commits, run state) stays inline and serial. A subagent never hands back, never touches the relay, and never communicates with the other agent. If your harness has no subagent dispatch, do the same reads sequentially.

Defined once and reused verbatim at every injection site so the rule cannot drift per-workflow. Exact wording is finalized at implementation time; the four load-bearing clauses above (harness-conditional; reads-only; synthesize-before-handback; subagents never touch the relay) are contractual.

### Injection sites (primary channel — mid-workflow handoff prompts)

Append the fragment to the composed kickoff text at three site families:

1. **Deliberation Explorer research-layer kickoffs** — the three research layers' templates (`DELIB_OBJECTIVES`, `DELIB_APPROACHES`, `DELIB_TRADEOFFS`), alongside the existing craft-skill pointer fragment already carried there. The **Synthesis** kickoff is explicitly excluded: it composes the findings doc from already-ratified layers (faithfulness work, not breadth research), the same rationale that excludes the diagnosis reviewer below.
2. **Every review-step kickoff that routes the reviewer into `ai-whisper-code-review`** — all **five** current templates composing `CODE_REVIEW_SKILL_GUIDANCE`: the SDD code-review phase, quick-task's implement-and-review review step, ralph's chunk review (`RALPH_ITEM_REVIEW`), ralph's final acceptance review (`RALPH_ACCEPTANCE_REVIEW`), and complex-bug-fixing's fix review (`BUGFIX_FIX_REVIEW`). The list is defined by composition — any template that carries `CODE_REVIEW_SKILL_GUIDANCE` carries the fan-out fragment too, so future code-review templates inherit it by construction. (The implementer's plan-execution kickoff is untouched; `ai-whisper-plan-execution` remains authoritative for execution structure.)
3. **Complex-bug-fixing diagnosis implementer kickoff** (the template that instructs writing the diagnosis artifact). The diagnosis *reviewer's* protocol is untouched — independent reproduction is execution, not reads.

### Discoverability channel (existing skills only)

Per the standing project decision (mid-workflow agent guidance = prompt fragment primary + sections in existing skills, never a new standalone skill):

- `ai-whisper-deliberation-craft`: one new Explorer-contract item — breadth via parallel read subagents where the harness supports it — plus a matching phrase in the per-layer research shape.
- `ai-whisper-code-review`: a short "Breadth reads" note.
- Optionally a one-line pointer in the thin `ai-whisper-bugfix` alias skill, only if it reads naturally there.

No new skill is created.

## Non-goals

- No parallel *implementation* subagents anywhere (plan-execution's existing prohibition stands).
- No broker capability detection, no protocol/schema changes, no state-machine changes.
- No changes to verdict vocabularies or evaluator prompts.

## Testing

- Substring assertions on **each composed kickoff handoff that must carry the fragment** — all five code-review templates (SDD code-review, quick-task review, `RALPH_ITEM_REVIEW`, `RALPH_ACCEPTANCE_REVIEW`, `BUGFIX_FIX_REVIEW`), the three deliberation Explorer research-layer kickoffs (`DELIB_OBJECTIVES`, `DELIB_APPROACHES`, `DELIB_TRADEOFFS`), and the bugfix diagnosis implementer kickoff — **nine positive assertions total**, plus **one negative assertion** that the deliberation Synthesis kickoff does *not* carry the fragment, locking the exclusion (the established pattern for verbatim-template registry edits — verify by substring match, not eyeballing).
- Deterministic skills QA for the edited skills: `shakespii lint` **and** `shakespii test` (without `--run`), matching the CI gate.
- Root `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build` green.

## Acceptance criteria

1. `WORKFLOW_READ_FANOUT_GUIDANCE` exists once in the registry and contains the four contractual clauses.
2. Every composed kickoff handoff that must carry the fragment contains it — all five code-review templates, the three deliberation Explorer research-layer kickoffs, and the bugfix diagnosis kickoff — each covered by its own substring test (nine positive), with a tenth negative test asserting the Synthesis kickoff omits it.
3. `ai-whisper-deliberation-craft` and `ai-whisper-code-review` carry the discoverability sections; **every bundled skill whose content changes gets a frontmatter `version` bump in the same change** (CI enforces this via `scripts/check-skill-version-bump.mjs`); no new skill exists in `packages/cli/skills/`.
4. All existing tests pass unchanged; root `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build` are green; `shakespii lint` and deterministic `shakespii test` pass for the edited skills.
5. A CHANGELOG entry is added before the next release that ships this.

## Sequencing

This lands **before** the pair-vs-solo evaluation campaign (see `2026-08-10-pair-vs-solo-eval-kit-design.md`) so the campaign measures the improved pair.
