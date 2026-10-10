# Pair-vs-Solo evaluation — campaign `billing-verify`

| Pin | Value |
|---|---|
| implementer model | claude-sonnet-5-5 |
| reviewer model (Arm C) | gpt-5.6-sol |
| evaluator | anthropic / — (fallback: — / —) |
| billing (claude seats) | subscription |
| CLI versions | whisper 0.16.0+afcc9bb, claude 2.1.293, codex 0.161.0 |
| run-order seed | 1 |

## Primary metric

Task success rate = successful runs ÷ (scheduled − unrecovered harness failures). A run succeeds iff the hygiene gate is fully green and 100% of held-out grade tests pass.

**INTERIM REPORT** — 2 of 45 scheduled runs have a ledger row; success rates use the fixed campaign denominator (ungraded runs count as not yet successful).

| Arm | Scheduled | Graded | Unrecovered harness failures | Successes | Success rate |
|---|---|---|---|---|---|
| A | 15 | 0 | 0 | 0 | 0.0% |
| B | 15 | 0 | 0 | 0 | 0.0% |
| C | 15 | 2 | 0 | 2 | 13.3% |

Interim graded-only rate (not the primary metric):

| Arm | Graded | Successes | Rate (interim) |
|---|---|---|---|
| A | 0 | 0 | — |
| B | 0 | 0 | — |
| C | 2 | 2 | 100.0% |

## Per-task breakdown

| Task | A | B | C |
|---|---|---|---|
| bug-money-rounding | 0/0 | 0/0 | 1/1 |
| csv-parse-quoted | 0/0 | 0/0 | 1/1 |

## Secondary metrics

| Arm | Micro pass fraction | Escalations | Mean rounds | Mean review findings | Mean seconds |
|---|---|---|---|---|---|
| A | — | 0 | — | — | — |
| B | — | 0 | — | — | — |
| C | 100.0% | 0 | 2.00 | 0.00 | 214 |

## Tokens & cost

Metered columns are computed over metered runs only.

Cost USD is **notional** for subscription-billed rows: metered tokens priced at the API rates in `pricing.json`, nothing was billed per token for the claude seats. The Arm C evaluator bills its own configured provider (the Anthropic API key in the state root's auth.json for `anthropic`), so that share of an Arm C row is real spend.

| Arm | Metered runs | Mean tokens (metered) | Mean cost USD (metered) | Estimated runs | character-based estimate — not comparable across arms |
|---|---|---|---|---|---|
| A | 0 | — | — | 0 | — |
| B | 0 | — | — | 0 | — |
| C | 2 | 1143455 | 0.9446 | 0 | — |

## Harness failures

None.

- Arm A: graded 0/15 scheduled
- Arm B: graded 0/15 scheduled
- Arm C: graded 2/15 scheduled

## Residual confounds

- Workflow prompts and generated artifacts (brief/spec, kickoff templates) exist only in Arm C.
- A second model (codex) occupies the reviewer seat in Arm C; Arms A/B have no second model.
- The evaluator (a third model call per handoff) exists only in Arm C.
- Arm C runs mounted interactive sessions; Arms A/B run headless `claude -p`.
- Arms are matched on token-budget parity only nominally: enforced from metered usage in A/B but from a character-based estimate in C.
- Fixture-authorship bias: the task author also tuned the system under test.
- Agents inherit the operator's claude/codex user configuration (global instructions, plugins, MCP servers, memory); sessions are not clean-room isolated.

## Caveat

Two trials per task per arm (n = 2) is directional evidence, not statistical proof. Differences between arms should be read as signals to investigate, not as significant effects.

Rows in ledger: 2 of 45 scheduled. This report is derived from ledger.jsonl alone.
