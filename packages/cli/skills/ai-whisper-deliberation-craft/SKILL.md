---
name: ai-whisper-deliberation-craft
description: Use when acting as Explorer or Challenger inside an active ai-whisper Deliberation run and need craft guidance to research or attack a layer (Objectives/Approaches/Tradeoffs) or verify a claim — not for starting a Deliberation (see ai-whisper-deliberation) — gives the Explorer research contract, Challenger attack taxonomy, and verification standard; the deliberation protocol stays authoritative for gate, verdict, and output format.
version: 0.1.0
---

# ai-whisper-deliberation-craft

## Intent

How to do the research (Explorer) and the attack (Challenger) in a Deliberation
run. This is craft guidance only — the deliberation review protocol in the
handoff prompt remains authoritative for the gate contract, the verdict, and
the output format. Do not restate or re-derive those rules here.

## Inputs

- The current layer being worked: Objectives, Approaches, or Tradeoffs (or
  Synthesis, for faithfulness checks).
- The role being played: Explorer (produces the layer's findings) or
  Challenger (attacks the Explorer's output before it advances).
- The seed topic and any prior-layer findings already committed.
- The deliberation review protocol from the handoff prompt — it governs the
  gate contract, verdict mechanics, materiality sorting, and output format;
  this skill never substitutes for it.

## Preconditions

- A Deliberation run is already in progress (kicked off separately — see
  `ai-whisper-deliberation` for starting one) and you have been handed a
  specific layer to research or attack.
- The deliberation review protocol for this run is available to you. Where it
  conflicts with anything below, the protocol wins.

## Procedure

### Explorer — research contract (every layer)

1. Ground every claim in a traceable source; label anything ungrounded as
   assumption/hypothesis.
2. Breadth before depth — enumerate the space before evaluating any
   candidate.
3. Triangulate across independent source types; prefer primary sources.
4. Log known-unknowns explicitly; they feed Open Questions and tell the
   Challenger where to dig.
5. Allocate research depth by decision-impact — go deep only where a gap
   would change a choice.

#### Per-layer research shape

- **Objectives:** research the real situation (current state, actual pain,
  constraints); derive objectives from evidence, do not restate the seed.
- **Approaches:** survey the space (prior art + in-repo idioms + candidate
  techniques); >= 3 distinct, each grounded in a real precedent; do not pick
  a winner.
- **Tradeoffs:** stress-test survivors against reality — feasibility checks,
  blast radius/difficulty in the actual codebase, named risks.

### Challenger — attack taxonomy

Each lens polices a specific Explorer discipline:

- **evidence** — is each claim grounded in a real, checkable source?
- **assumption** — what unstated premise is load-bearing?
- **alternative** — what distinct option was missed?
- **feasibility** — does it actually work in this codebase / at this scale?
- **second-order** — what downstream cost or risk is buried?
- **framing** — is the QUESTION itself right? (highest-leverage,
  most-skipped)

Per-layer weighting: objectives -> framing + assumption; approaches ->
alternative + evidence; tradeoffs -> feasibility + second-order; synthesis ->
faithfulness.

### How to verify (both roles)

Verify by materiality and surface, not by felt confidence: open the file,
re-run the grep, fetch the source, check the real API. A shared prior is not
verification.

## Output

- **Explorer, per layer:** a findings write-up shaped by the per-layer
  research shape above — Objectives grounded in the real situation, >= 3
  distinct grounded Approaches with no winner picked, or stress-tested
  Tradeoffs with named risks — with every claim either traced to a source or
  explicitly labeled assumption/hypothesis, plus a logged list of
  known-unknowns.
- **Challenger, per layer:** a set of attack findings organized by the lenses
  weighted for that layer (e.g. framing + assumption for Objectives,
  alternative + evidence for Approaches, feasibility + second-order for
  Tradeoffs), each one backed by an actual check (file opened, grep re-run,
  source fetched) rather than a felt-confidence objection.
- The deliberation review protocol governs how this output is packaged into
  the gate/verdict — this skill only shapes the content that goes into it.

## Examples

Input: Explorer is assigned the Approaches layer for a seed proposing
"speed up the CI pipeline." Prior-layer (Objectives) findings already
establish the real pain: CI takes 22 minutes median, and the constraint is a
shared runner pool capped at 4 concurrent jobs.

Explorer's process: survey prior art (blog posts on test sharding, the
project's own `.github/workflows/ci.yml` for current job structure) and
in-repo idioms (an existing `scripts/test-shard.sh` that's unused). Per the
research contract's floor, it produces distinct, grounded approaches without
ranking them:

1. **Test sharding** — split the existing suite across the 4 runners using
   `scripts/test-shard.sh` (already in-repo, sitting unused); grounded in
   the repo's own tooling.
2. **Dependency-graph caching** — cache `node_modules` keyed on lockfile
   hash, per the GitHub Actions cache docs; grounded in a primary source.
3. **Test selection by changed files** — run only tests affected by the diff,
   per a precedent in `similar-project/ci.yml` (public repo); grounded in an
   external example, flagged as needing an in-repo feasibility check next
   layer.

Known-unknowns logged: whether the shared runner pool's disk I/O, not CPU, is
the actual bottleneck — unverified, flagged for the Tradeoffs layer.

Output: a committed Approaches findings write-up listing the three options
above, each with its grounding source, no approach marked as the winner, and
the disk-I/O unknown logged for the Challenger and the next layer to dig
into.

## Anti-patterns

- Restating or re-deriving the gate contract, verdict mechanics, or output
  format here — that lives in the deliberation review protocol, not this
  skill.
- Picking a winning approach during the Approaches layer instead of
  surveying the space and leaving the choice for Tradeoffs.
- Presenting an ungrounded claim as fact instead of labeling it
  assumption/hypothesis.
- Verifying a Challenger objection by felt confidence or shared prior instead
  of actually opening the file, re-running the grep, or fetching the source.
- Treating this skill as the way to start a Deliberation run — kicking off
  the workflow is a different skill's job (`ai-whisper-deliberation`).
