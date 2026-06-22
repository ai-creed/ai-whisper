# Deliberation Workflow — Design

**Status:** Design / pre-implementation. v1 is scoped as an experiment (see §13).
**Date:** 2026-06-22
**Context:** ai-whisper — a fourth autonomous workflow alongside `spec-driven-development`, `ralph-loop`, and `complex-bug-fixing`.

## 1. Summary

Deliberation is a paired-agent ai-whisper workflow in which two agents autonomously research a project-grounded idea, adversarially stress-test it, and surface synthesized findings for human review. It runs the same implementer/reviewer engine as the existing workflows, but where those assume you already know *what* you want, Deliberation handles the stage *before* that: a fuzzy idea that needs its space mapped before you commit.

The output is a findings document — objectives, approaches, tradeoffs, a clearly-marked overridable recommendation, risks, and open questions — not a binding spec and not code. It exists to reduce the human effort required during early-stage exploration: the agents do the legwork and the adversarial thinking while you are unavailable, and hand you a structured starting point for a later, higher-leverage decision or brainstorm.

## 2. Why this exists (north star)

The optimization target, in three nested layers:

1. **Decision support, not truth-seeking.** Most early-stage engineering questions have no objectively correct answer. The workflow's job is to produce what a human needs in order to *decide*, not to find "the truth."
2. **Project-grounded.** The topic is almost always something arising while working on a concrete project. Every claim is researched and verified against *that project's* reality — its code, tests, history, docs, and recorded decisions — not against model priors.
3. **Minimize the human's thinking effort.** The scarce resource is the user's attention and cognition, not tokens. Whenever there is a tradeoff between more agent work and more human work, shift it to the agent. Thoroughness is the product; token cost is explicitly a secondary concern.

## 3. Where it fits among the workflows

| Workflow | You must be able to… | Output |
| --- | --- | --- |
| spec-driven-development | describe the deliverable up front | code under an approved plan |
| ralph-loop | describe the finished state | code, chunk by chunk |
| complex-bug-fixing | point at a reported bug | a verified fix |
| **deliberation** | **only have a fuzzy idea** | **a findings doc that feeds the above** |

Deliberation is the pre-spec stage. Its output is frequently the input you would later hand to brainstorming or SDD — but it **never auto-chains** there. Handing the findings onward is always your decision.

## 4. Roles and the core pattern

Two agents — the existing pair (implementer + reviewer) — playing a dialectic:

- **Explorer (implementer):** researches, expands the idea, proposes.
- **Challenger (reviewer):** critiques assumptions, exposes blind spots, forces alternatives, identifies risks.

The pattern is **Proposal → Critique → Refinement → Synthesis** — a structured dialectic, not a simulated conversation. The transcript is exhaust; the product is the refined end-state (the "state transitions"), which is why the transcript stays ephemeral (§12) and only the synthesis is committed.

**Cross-model asymmetry is a hard default.** The Challenger runs on a different model/provider than the Explorer (e.g. codex challenging claude, via the existing `--implementer`/`--reviewer` config and the `ezio` replacement role). This is the cheapest available decorrelation of priors and is essential to the gate working (§7).

## 5. Structure: ordered reasoning layers, each a gated dialectic loop

The deliberation is decomposed into an ordered pipeline of *reasoning layers*, mirroring how a human-in-the-loop exploration actually proceeds. Each layer is ratified before the next builds on it, so a flawed foundation is caught early — not after the whole exploration has been built on top of it.

This composes two orthogonal axes:

- **Content axis (the layers):** what is deliberated, in order — foundations first.
- **Process axis (within each layer):** propose → critique → refine → check-convergence.

A layer **is** an ai-whisper phase; the propose/critique/refine loop **is** that phase's round-loop; the gate **is** the convergence check. Nothing new is required in the engine for the structure itself.

**The layers:**

1. **Objectives** — derive the objectives and success criteria from the seed. Gate: are these the *right* objectives — misframed, missing, assumed? (Highest-weighted attacks: framing, assumption.)
2. **Approaches** — research and propose N genuinely distinct approaches to reach the objectives. The Explorer **may not pick a winner** here (the guard against premature convergence). Gate: is the set complete, are any non-starters included, is each grounded and feasible? (Attacks: alternative, evidence.)
3. **Tradeoffs & difficulty** — map tradeoffs, difficulty, blast radius, and risk per surviving approach. Gate: honest and complete, or cherry-picked / buried costs? (Attacks: feasibility, second-order.)
4. **Synthesis** — collapse the ratified layers into the findings document (§9). Gate: faithful to the deliberation; are the open questions the *right* ones?

## 6. Scope: project-grounded, with graceful degradation

The design center is **project-grounded deliberation**: the seed points at something real in the project, and the Explorer's primary research surface is that project — codebase, tests, git history, docs, and — best-effort — recorded decisions (ai-cortex memory). Web research is secondary, used only when the question reaches beyond the project (prior art, library evaluation).

Memory consultation is **best-effort by design**: ai-whisper does not inject MCP servers into the spawned `codex`/`claude` agents, so ai-cortex is available only when the user has configured it in that CLI's own global config (the in-house `ezio` agent has native cortex rehydration via `loadMcpHost`). The Explorer uses recorded decisions when present and otherwise grounds on code, tests, git history, and docs alone — memory is never a hard dependency.

Project-grounding is not only a scoping choice — it is what makes the gate's forced external verification (§7) *cheap*: when ground truth is the local repo, "open the file and check" costs almost nothing. This is the common case, so the most expensive decorrelation move is also the cheapest exactly where it is used most.

A seed with no project anchor **degrades gracefully** — it falls back to web-grounded research, with weaker verification and more open questions — rather than being refused. The abstract long tail is not designed *for*, but is not forbidden.

## 7. The gate: producing genuine adversarial pressure

This is the load-bearing, genuinely-new part of the build. The gate must thread two opposite failures at once:

- **Weak challenge** — the Challenger rubber-stamps → a confident, shallow, useless report.
- **Endless / manufactured challenge** — the Challenger fabricates disagreement → never converges, produces noise.

The mechanism:

- **Decision-materiality is the bar, and it sorts findings four ways.** A finding is **blocking** (it drives *not-approved*) only if it would change a reasonable decision-maker's choice. A finding that is material *but depends on the human's private preference* is surfaced as an **Open Question candidate**. A finding that is a real but non-decision-changing risk (speculative / architectural) is surfaced on the **non-blocking risk channel** — never gagged merely for being outside the gate's explicit criteria. Only pure noise (style / taste) is **suppressed**. This single bar gives convergence a floor (cannot loop on quibbles), makes approval a falsifiable claim (weak challenge becomes auditable), and generates the decision-support payload.
- **Independent derivation (skin in the game).** At each layer's first review, the Challenger must derive its *own* candidate (its own objectives / its own approach set) *before* reading the Explorer's, then diff. This converts "do you agree?" (a free yes) into "you derived X, I derived Y, where is the material gap?" — and mechanically surfaces missing alternatives and buried costs. (Re-derivation happens once per layer; fix-rounds re-audit the revision.)
- **Forbid recall-based verification.** Two same-corpus agents share not only knowledge but blind spots, so a shared hallucination never *sounds* uncertain to either. The Challenger may **not** clear a material claim with "that matches what I know." Only an external check counts — re-run the grep, open the cited file, fetch the source, check the actual API. Every material claim it ratifies carries a "verified against `<source>`". A material claim that cannot be externally verified within the run becomes an Open Question marked "could not verify — you should."
- **Verify by materiality and surface, not by felt uncertainty.** Because an agent's confidence is miscalibrated by shared priors, the trigger for verification is not "this sounds shaky" but "this is load-bearing" and "this is a specific or suspiciously-convenient fact" (version numbers, API signatures, file paths, citations, benchmark figures, an API that does exactly what is needed).
- **Steelman, then attack, with coverage.** Each review states the strongest version of the Explorer's position, then surfaces at least one unexamined assumption, one missing alternative, and one material risk — or explicitly certifies that each lens was run and why none is decision-material. "Looks good" is not a legal handback.
- **Skeptical persona = distrust your own agreement.** The Challenger is primed to treat its own "yeah, that's right" as a red flag, not a green light — meta-distrust of shared confidence. This is the agent-appropriate form of human skepticism, which in a human is driven by a knowledge gap the agent does not have.
- **Generative mandate.** Beyond auditing the Explorer, the Challenger independently *generates* angles and alternatives the Explorer did not — accepting that this is the part most exposed to the limits of both agents' combined priors.
- **The Challenger emits approved / not-approved + findings, never a workflow verdict.** It states whether the layer's output is approved, with blocking findings as the reasoning for non-approval, plus Open Question candidates and non-blocking risks. It does **not** label the workflow outcome (advance / loop / escalate) — classifying the exchange into a verdict is the orchestrator evaluator's job, consistent with the existing reviewer/evaluator boundary. If required context is missing and the Explorer cannot supply it, the Challenger does **not** approve and names the missing input (it does not "proceed from partial context").
- **The evaluator polices challenge quality.** ai-whisper's third-party evaluator independently reads the exchange and rejects a *hollow* approval — no real derivation, no lens attacked, a layer ratified in round 1 with zero findings. Weak challenge therefore has two defenders: the protocol *forces* the work, and the evaluator *detects its absence*. This requires a **deliberation-specific evaluator prompt** (a new `deliberation-loop` key, §12 item 2): the generic `review-loop` evaluator is classification-only — explicitly instructed *not* to re-review and to accept an approval whenever the reviewer's intent to approve is clear (`packages/cli/src/runtime/relay-orchestrator-evaluator.ts:164-183`) — so on its own it would wave a hollow approval straight through. The deliberation prompt instead audits an apparent approval for the artifacts above *before* accepting it. This is meta-review of the *challenge* (did the Challenger do its job?), not re-review of the Explorer's deliverable, so the reviewer/evaluator boundary holds: the Challenger still emits only approved / not-approved + findings, and the evaluator still owns the verdict.

## 8. Role craft: one contract, two views

The Explorer's research discipline and the Challenger's attacks are duals: **the Challenger's job is to audit whether the Explorer honored its research contract.** They are therefore written as one shared document (the bundled craft skill, §12).

**Explorer research contract (cross-layer disciplines):**

1. Ground every claim in a traceable source; explicitly label anything ungrounded as assumption/hypothesis.
2. Breadth before depth — enumerate the space before evaluating any candidate.
3. Triangulate across independent source types; prefer primary sources.
4. Log known-unknowns explicitly; they feed Open Questions and tell the Challenger where to dig.
5. Allocate research depth by decision-impact — go deep only where a gap would change a choice.

**Per-layer research shape:** objectives research the *real situation* (current state, actual pain, constraints) and derive objectives from evidence rather than restating the seed; approaches survey the space (prior art + in-repo idioms + candidate techniques), ≥N distinct, each grounded in a real precedent; tradeoffs stress-test survivors against reality (feasibility checks, blast radius/difficulty in the actual codebase, named risks).

**Challenger attack taxonomy:** evidence · assumption · alternative · feasibility · second-order · framing. Each polices a specific Explorer discipline; framing (is the *question itself* right?) is the highest-leverage and the most-skipped.

**Per-layer attack weighting:** objectives → framing + assumption; approaches → alternative + evidence; tradeoffs → feasibility + second-order; synthesis → faithfulness.

## 9. Output: the findings document

Optimized for minimal human reading effort. The TL;DR and Objectives carry the fast read; the grounding footer states how much to trust it.

```
# Deliberation: <topic>
seed: <path> · <date> · <implementer>/<challenger>

## TL;DR                          ← the 5-second read
- Recommended direction: <one line> (PROPOSAL)
- Decisions that need you: <the 1–2 top Open Questions>

## Objectives (ratified)          ← the "did it understand me?" check, on top
- <objective> — why it matters [source]
- interpretation taken: …; discarded: …   (only when the seed was vague)

## Approaches considered          ← table-first so it is scannable
| Approach | Gist | Grounding/precedent | Key tradeoff | Difficulty |
(one short paragraph per surviving approach only)

## Recommendation (PROPOSAL — overridable)
<which, why over the others, and what the Challenger attacked + how it held>

## Risks
- <material risk to the recommended direction>

## Open Questions (for you)       ← the decision-support payload
- <decision> — what is at stake / why it was not settled
- <"could not verify X — you should">

## Grounding & confidence (footer)
verified against source: … · assumed (unverified): … · couldn't verify: …
```

The document lives in the project's `docs/`, date-stamped like the existing specs. The deliberation transcript does **not** appear here — it stays in the gitignored run directory (§12).

## 10. Seed contract

- **Required:** a topic/goal statement — one line suffices (e.g. *"integrate 14all + samantha so samantha supervises 14all-executed work"*). What is required is a non-empty topic to deliberate on, **not** that it name a project artifact. Project-grounding is the common and strongly-preferred case (§6), because it is what makes the gate's external verification cheap — but a topic with no project anchor is **accepted and degrades to web-grounded research (§6), never refused.** The kickoff skill validates only that the seed file resolves and is non-empty, exactly as the other workflows validate their spec/goal/bug-report path.
- **Highest-value optional addition:** a single intent-anchor / non-goal line (e.g. *"supervise = monitor, NOT control"*). This is the cheapest decorrelator against a *shared* misinterpretation — the failure the framing attack alone cannot catch, because two correlated agents can both find the same wrong reading "most plausible."
- **Other optional, accelerative fields:** hard constraints, output-flavor.

Seed quality is **not measured up front** — the Objectives layer normalizes it: a rich seed ratifies fast; a thin seed does more interpretation work and may escalate. Adequacy is therefore an *observable, emergent* property (did Objectives ratify cleanly, or escalate?), not an up-front judgment. The ratified Objectives sit at the top of the findings doc precisely so a misinterpreted vague seed is the first thing the human sees.

Format: a **file**, resolved by the kickoff skill exactly as the other workflows resolve their spec/goal/bug-report paths. The file may be a single line.

## 11. Termination

No objective "done" exists, so the stop-rules are deliberate. The governing distinction:

- **Soft stop (Open Question → advance):** a material-but-preference-dependent fork the agents should not resolve. Recorded in Open Questions; the run continues. The common case.
- **Hard stop (escalation → halt):** the run cannot proceed usefully without the human. Rare by design.

Both outcomes are decided by the orchestrator **evaluator** from the Challenger's findings and where the round sits against the cap — the Challenger supplies the signal (approved / not-approved + findings + risks), never the verdict (§7). The evaluator making this call is the deliberation-specific `deliberation-loop` prompt (§7, §12 item 2); in v1 it reasons over the current handback plus the round counter, **not** a materiality trajectory (see rule 3).

Rules:

1. **Per-layer convergence is by materiality decay** — a layer ratifies when no decision-material finding remains. The Challenger approves; the evaluator advances. This, not the round budget, is the expected stop, and it rides the existing approve → advance path — no new termination plumbing.
2. **Round budgets are generous safety caps, not the expected stop** (defaults, configurable): objectives 6 · approaches 10 · tradeoffs 10 · synthesis 5. Read as "rarely reached." At the cap, a still-blocking not-approval is forced to escalate by the existing workflow normalization (`packages/broker/src/control/workflow-control.ts:394-402`) — the backstop that guarantees the run always terminates.
3. **Soft vs hard is a judgment of the current handback, not of a trajectory.** Per the four-way materiality sort (§7), only a *blocking* finding drives not-approved; a material-but-preference-dependent fork is non-blocking, so the Challenger *approves* and lists it as an Open Question. The soft stop is therefore an ordinary approval that carries Open Questions — the evaluator advances once it confirms the approval is non-hollow. A *genuine* unresolved gap (the Explorer cannot ground a claim or produce a feasible approach) keeps the layer not-approved → loop, and at the cap → escalate (rule 2). **Deferred to v2: early materiality-stall escalation** — escalating a genuinely-contested layer *before* its cap because material findings stopped decaying. That alone needs the per-round materiality *trajectory* in the evaluator payload, which v1's evaluator input does not carry (`packages/cli/src/runtime/relay-orchestrator-evaluator.ts:35-44`); v1 instead lets a contested layer run to its generous cap and escalates there via rule 2. v1 *logs* the trajectory (§12 item 6) so the experiment can judge whether early-stall detection is worth building.
4. **Whole-run termination is structural:** the run is done when the terminal Synthesis layer ratifies. There is no fuzzy "are we done deliberating?" — a direct benefit of the fixed-backbone structure over an open-ended loop.
5. **No backward auto-loops:** when a later layer surfaces that an earlier ratified one is wrong (*"exploring tradeoffs, I found the objective is wrong"*), the Explorer hands back a cannot-proceed signal with the reason and the evaluator **escalates** — rather than the loop silently re-opening the earlier layer (ping-pong hazard) or proceeding on a cracked foundation. Mirrors the bugfix "approved cause is wrong → cannot proceed" rule. (v2 may allow bounded self-correction.)
6. **Convergence is evaluator-audited, not Challenger-asserted** (§7).

Total work is bounded by (layers × caps); materiality-decay keeps the *expected* run far below that worst case, and the cap (rule 2) guarantees it always terminates.

## 12. Build surface

Mostly additive and low-risk to the existing three workflows. The intellectual weight is concentrated almost entirely in the gate (item 2).

1. **New `WorkflowDefinition`** in `packages/broker/src/runtime/workflow-registry.ts` — phases = the four layers, each with kickoff/review/fix templates, `reviewMode`, `artifactOut: { kind: "spec", pathTemplate: <findings-doc> }`, and per-layer `maxRounds`; registered in `REGISTRY` via `withOperatorControl`. (Copy the SDD shape.)
2. **New reviewer gate protocol + a deliberation-specific evaluator prompt.** Two coupled pieces:
   - **The reviewer protocol constant (the heart of the build).** A new constant built on the diagnosis protocol's adversarial spine, retargeted to decision-support and per-layer ratification, encoding §7 — added inline registry-side like `WORKFLOW_DIAGNOSIS_PROTOCOL`. ~90% of the design effort, ~10% of the code.
   - **A new `deliberation-loop` evaluator key.** Deliberation reuses the review-loop **verdict space and routing shape** (approve→advance, findings→loop, escalate→halt) — but **not** the review-loop *prompt*. The generic `review-loop` prompt is classification-only: it is told *not* to re-review and to approve whenever the reviewer's intent to approve is clear (`packages/cli/src/runtime/relay-orchestrator-evaluator.ts:164-183`), so it would pass a hollow approval straight through and defeat §7. The `deliberation-loop` prompt instead audits an apparent approval for the §7 rigor artifacts before accepting it (hollow → loop). This corrects an earlier design assumption that the workflow could reuse the review-loop prompt unchanged (§13). Evaluator plumbing is therefore **small but non-zero**: a new key + new system prompt + schema selection on the deliberation phases, mirroring the existing `review-loop` / `execution-gate` / `ralph-loop` keys. It needs **no new evaluator *input* field** in v1 — it reasons over the current handback only; the per-round materiality trajectory that early-stall detection would need is deferred to v2 (§11 rule 3, §13).
3. **Run-dir + paths** — a `deliberationRunDir` (gitignored transcript/working notes) and the committed findings-doc path, mirroring `bugfixPaths` / `ralphRunDir`, plus the `{placeholder}` plumbing the driver renders.
4. **Kickoff skill** `ai-whisper-deliberation` — mirror `ai-whisper-sdd`: resolve the seed path, verify collab readiness, run `whisper workflow start`, then exit (fire-and-forget).
5. **Craft skill** — one bundled craft skill carrying the shared research-contract / attack-taxonomy (§8), referenced from the handoff templates by a one-line guidance prefix like `CODE_REVIEW_SKILL_GUIDANCE` / `PLAN_EXECUTION_SKILL_GUIDANCE`. The gate *mechanics* (§7) stay inline in the registry as a protocol constant like `WORKFLOW_DIAGNOSIS_PROTOCOL`; the *craft* goes in the skill. This split matches prior rulings (rich role-craft may be a bundled skill; thin mid-workflow nudges may not). The craft skill is how-to only; it must **not** restate the gate protocol or severity rules — the inline registry protocol fragment is the canonical single source of truth for the gate contract, and bundled skills must not duplicate it.
6. **Instrumentation** — per-round logging of findings-materiality and Explorer-revision magnitude. In v1 this is **evidence, not a control signal**: it feeds the experiment's evaluation (§13) and the v2 decision on whether early materiality-stall detection (§11 rule 3) is worth building. No v1 mechanism consumes it — v1 convergence rides materiality-decay (approve → advance) and the round-cap backstop.
7. **Docs + tests** — `docs/workflows.md` (including its "choosing the workflow" section) and test coverage matching the other workflows' bar.

## 13. v1 framing and open items

v1 is an **experiment with a quality kill-criterion**: build the smallest correct version, point it at ~3 real fuzzy ideas, and read the outputs. Decision-useful → invest further (more layers, abstract-topic support). Confident mush → the agent-Challenger cannot substitute for human steering, and we have spent little to learn it. The instrumentation (item 6) is the evidence; cost is explicitly not part of the kill-criterion (§2.3).

**Deferred to v2:** dynamic-depth layers (vs. the fixed backbone); bounded backward self-correction (vs. escalate-on-invalidation); first-class support for abstract (non-project) topics; **early materiality-stall escalation** — escalating a contested layer before its cap, which needs the per-round materiality trajectory threaded into the evaluator payload that v1 does not carry (§11 rule 3).

**Confirmed during design (2026-06-22):**

- *Memory in the autonomous run* — ai-whisper does **not** inject MCP servers into the spawned `codex`/`claude` agents (no MCP wiring anywhere in `packages`). ai-cortex is available only if the user has it in that CLI's own global config, so §6/§8 memory consultation is **best-effort**, not guaranteed (the in-house `ezio` agent has native cortex rehydration via `loadMcpHost`). *Deferred enhancement:* wire ai-cortex explicitly into the spawned agents to make it reliable.
- *Evaluator key* — **a new `deliberation-loop` key IS needed** (this corrects an earlier design assumption). Deliberation reuses the review-loop *verdict space and routing shape*, but **not** its prompt: the `review-loop` system prompt is classification-only — instructed not to re-review and to approve on clear reviewer intent (`packages/cli/src/runtime/relay-orchestrator-evaluator.ts:164-183`, verified 2026-06-22) — so it cannot reject the hollow approval that §7 makes load-bearing. The new key carries a prompt that audits the approval's rigor. The reviewer protocol constant remains the larger piece of work, but evaluator plumbing is non-zero (§12 item 2).
