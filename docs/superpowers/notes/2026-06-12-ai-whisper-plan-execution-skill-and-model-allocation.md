# Idea: an ai-whisper-dedicated plan-execution skill + a model-allocation policy

**Project:** ai-whisper · **Date:** 2026-06-12 · **Status:** idea / brainstorm (not yet designed — do NOT build before a design pass)
**In-repo mirror:** `docs/superpowers/notes/2026-06-12-ai-whisper-plan-execution-skill-and-model-allocation.md`
(centralized copy is canonical per the local-docs convention; the repo copy is the committable mirror)

## Why this came up

While executing the `keep-ezio-fresh` plan during the autonomous SDD workflow, the implementer ran the whole plan **manually on Opus** (no subagents) and never invoked the plan's stated `REQUIRED SUB-SKILL` (`superpowers:subagent-driven-development` / `superpowers:executing-plans`). Two problems surfaced:

1. **The global skills don't fit the autonomous context.** `executing-plans` and `subagent-driven-development` are built around **human review checkpoints between tasks**. The ai-whisper autonomous workflow has no human in that turn — the implementer agent receives an "execute the plan" handback and must finish and hand back. The checkpoint model is a misfit, which is part of why the agent defaulted to going fully manual.
2. **Model allocation was "Opus-everything."** No use of cheaper execution tiers, and — more importantly — no independent reviewer layer. A Fable-orchestrator → Sonnet-implementer → Fable-reviewer split would likely have been cheaper *and* added a review pass the manual run never had.

## The idea

Create a **thin, ai-whisper-dedicated plan-execution skill** (working name `ai-whisper-execute-plan`) that is used when the autonomous SDD workflow reaches the implementation phase. It should **compose with**, not fork, the global superpowers skills.

### Compose, don't fork (important)

Copy-paste-modifying the two global skills is a maintenance trap: it re-derives proven content (TDD discipline, fresh-subagent-per-task, two-stage review) and then drifts from upstream improvements permanently. Instead the ai-whisper skill should **delegate to / reference** the global `subagent-driven-development` mechanics and only **add the layer that is genuinely ours**:

1. **Model-allocation policy** (see below) — per-subagent `model:` overrides on the Agent tool.
2. **Autonomous-mode rule** — no human gate, so substitute a **reviewer subagent** for the missing between-task checkpoint.
3. **ai-whisper specifics** — the `whisper workflow` handback contract (fire-and-forget, substantive ≥2-sentence handback), the AGENTS.md verification quartet (`test`/`typecheck`/`lint`/`build`) + bundle smoke, the worktree + ezio-sibling-symlink setup, commit conventions, and the bundled `ai-whisper-code-review` skill.

## Conflict / coexistence analysis

**No conflict** as long as the new skill has a **distinct name**. Plugin skills are namespaced (`superpowers:subagent-driven-development`); a project skill at `.claude/skills/<name>/` is invoked by its own bare name and coexists. The repo already does exactly this (`ai-whisper-sdd`, `ai-whisper-bugfix`, `ai-whisper-code-review`, `ai-whisper-ralph`), and there is a standing decision to bundle the code-review skill inside ai-whisper workflows. So: name it `ai-whisper-execute-plan` (or similar), do not shadow `executing-plans`.

## The model-allocation policy (from a Fable 5 consult)

Available tiers (strongest → cheapest/fastest): **Opus 4.8**, **Fable 5**, **Sonnet 4.6**, **Haiku 4.5**. The Agent tool supports a per-subagent `model` override.

### Role → model defaults

| Role | Default | Flip condition |
| --- | --- | --- |
| Orchestrator | Fable 5 | ↑ Opus if the plan is weak/ambiguous and the orchestrator must improvise design; ↓ Sonnet for tiny plans. |
| Implementer | Sonnet 4.6 | ↑ Fable if ambiguous / novel / cross-cutting; ↓ Haiku only for codemod-shaped work behind a typecheck gate. |
| Reviewer / adversarial verifier | Fable 5 | Never below the implementer's tier. |
| Mechanical / boilerplate | Haiku 4.5 | ↑ Sonnet if it secretly touches shared types / public API. |
| Test-writer | Sonnet 4.6 | ↑ Fable for adversarial / edge-case / repro tests. Never Haiku. |
| Verification runner | Haiku 4.5 | ↑ Sonnet if it must *diagnose* failures, not just report them. |
| Synthesis | Sonnet 4.6 | ↑ Fable if the output drives decisions (re-plan / rewrite spec). |

### Load-bearing principles

- **Reviewer tier ≥ implementer tier — always.** A weaker reviewer cannot distinguish "sophisticated and correct" from "sophisticated and wrong," so it rubber-stamps; a confident false approval is the worst output the pipeline can produce. Review is read-mostly and short, so upgrading it is a rounding error next to implementer tokens. (Lower-confidence bonus: a *different* model family reviewing decorrelates blind spots — Fable reviewing Sonnet beats Sonnet reviewing Sonnet.)
- **Escalate on retry, don't start high.** On the 2nd failed review of the same task, bump the implementer one tier and pass the failure history into the dispatch prompt.
- **Spend on judgment roles (orchestrator, reviewer); economize on execution roles (implementer, mechanical); never economize where failure is silent — reviews and tests.**

### Default policy (orchestrator-executable)

```
orchestrator=Fable · implementer=Sonnet · reviewer=Fable
mechanical + verification-runner=Haiku · test-writer + synthesis=Sonnet
invariant: reviewer tier >= implementer tier
upshift implementer -> Fable if ambiguous / novel / security / >5 files / concurrency
downshift implementer -> Haiku only if codemod-shaped AND gated by typecheck/tests
2nd failed review -> escalate implementer one tier + pass failure history
```

Deviations: tiny 3-file plan → Sonnet orchestrator, skip the reviewer subagent (orchestrator self-reviews); 30-file migration → Opus orchestrator, pin Fable reviewers on the seam / integration tasks even if implementers stay Sonnet.

### Failure modes to avoid

- **Cheap reviewer (Haiku)** → review becomes theater; defects pass both stages. Worst single mistake.
- **Cheap orchestrator** → errors multiply across every task.
- **Cheap test-writer** → tests that assert nothing give false-green forever; verification stage permanently corrupted.
- **Opus-everything** → wall-clock blowup on serial task loops, zero marginal quality on well-specified tasks, and an over-engineering tax (strong models invent unrequested scope).

## Open questions (resolve in the design pass, before building)

1. **Macro vs micro review.** The ai-whisper workflow *already* has macro review — claude implements, ezio reviews at the workflow level. The subagent model-policy operates at a finer grain (fan-out *inside* the implementer's turn). Decide deliberately whether we are adding micro-review under the existing macro-review, or whether subagent fan-out is mainly for **big plans** one turn can't hold — otherwise we double up review and pay twice.
2. **Skill vs. lighter homes.** Is a full new skill warranted, or is the new content small enough to live as (a) a section appended to the existing `ai-whisper-sdd` skill, or (b) an ai-cortex memory? The autonomous-no-checkpoint mismatch is the strongest argument *for* a dedicated skill; the model matrix alone might not justify one.
3. **Hook into the handback contract.** How does the skill keep the fire-and-forget + substantive-handback requirement intact while fanning out to subagents (the implementer's turn must complete and hand back; floating subagents must settle first)?
4. **Where the policy is enforced.** A skill is the only place that is truly "in front of the agent at execution time" without editing the fragile vendored plugin file — but it is still advisory, not a hard mechanism. Accept that, or add a lighter guard (e.g. a checklist the orchestrator must tick)?
5. **Cost ceilings / opt-out.** Should the policy respect a token budget and degrade (e.g. drop reviewer subagents under a ceiling)? Should there be an explicit "go manual" escape for trivial changes?

## Suggested next steps

1. Brainstorm the skill's shape (resolve the open questions above, esp. #1 and #2).
2. If a skill is the answer, use `superpowers:writing-skills` to author `ai-whisper-execute-plan` as a thin composer over `subagent-driven-development`.
3. Decide the durable home for the model policy (skill body vs. AGENTS.md vs. global `~/.claude/CLAUDE.md` + memory) — leaning: skill body for the execution-time policy, with a short pointer in AGENTS.md.
