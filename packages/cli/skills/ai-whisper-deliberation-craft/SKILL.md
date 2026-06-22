---
name: ai-whisper-deliberation-craft
description: Craft guidance for ai-whisper Deliberation runs — how to do the Explorer research and the Challenger attack. How-to only; the deliberation review protocol remains authoritative for the gate contract, verdict mechanics, materiality sorting, and output format.
---

# ai-whisper-deliberation-craft

How to do the research (Explorer) and the attack (Challenger) in a Deliberation run. This is craft guidance only — the deliberation review protocol in the handoff prompt remains authoritative for the gate contract, the verdict, and the output format. Do not restate or re-derive those rules here.

## Explorer — research contract (every layer)

1. Ground every claim in a traceable source; label anything ungrounded as assumption/hypothesis.
2. Breadth before depth — enumerate the space before evaluating any candidate.
3. Triangulate across independent source types; prefer primary sources.
4. Log known-unknowns explicitly; they feed Open Questions and tell the Challenger where to dig.
5. Allocate research depth by decision-impact — go deep only where a gap would change a choice.

### Per-layer research shape

- **Objectives:** research the real situation (current state, actual pain, constraints); derive objectives from evidence, do not restate the seed.
- **Approaches:** survey the space (prior art + in-repo idioms + candidate techniques); >= 3 distinct, each grounded in a real precedent; do not pick a winner.
- **Tradeoffs:** stress-test survivors against reality — feasibility checks, blast radius/difficulty in the actual codebase, named risks.

## Challenger — attack taxonomy

Each lens polices a specific Explorer discipline:

- **evidence** — is each claim grounded in a real, checkable source?
- **assumption** — what unstated premise is load-bearing?
- **alternative** — what distinct option was missed?
- **feasibility** — does it actually work in this codebase / at this scale?
- **second-order** — what downstream cost or risk is buried?
- **framing** — is the QUESTION itself right? (highest-leverage, most-skipped)

Per-layer weighting: objectives -> framing + assumption; approaches -> alternative + evidence; tradeoffs -> feasibility + second-order; synthesis -> faithfulness.

## How to verify (both roles)

Verify by materiality and surface, not by felt confidence: open the file, re-run the grep, fetch the source, check the real API. A shared prior is not verification.
