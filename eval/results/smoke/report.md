# Pair-vs-Solo evaluation — campaign `smoke`

| Pin | Value |
|---|---|
| implementer model | claude-sonnet-5-5 |
| reviewer model (Arm C) | gpt-5.6-sol |
| evaluator | anthropic / — (fallback: — / —) |
| CLI versions | whisper 0.16.0+e7b1d1e, claude 2.1.293, codex 0.161.0 |
| run-order seed | 20260819 |

## Primary metric

Task success rate = successful runs ÷ (scheduled − unrecovered harness failures). A run succeeds iff the hygiene gate is fully green and 100% of held-out grade tests pass.

**INTERIM REPORT** — 3 of 45 scheduled runs have a ledger row; success rates use the fixed campaign denominator (ungraded runs count as not yet successful).

| Arm | Scheduled | Graded | Unrecovered harness failures | Successes | Success rate |
|---|---|---|---|---|---|
| A | 15 | 1 | 0 | 1 | 6.7% |
| B | 15 | 1 | 0 | 1 | 6.7% |
| C | 15 | 1 | 0 | 1 | 6.7% |

Interim graded-only rate (not the primary metric):

| Arm | Graded | Successes | Rate (interim) |
|---|---|---|---|
| A | 1 | 1 | 100.0% |
| B | 1 | 1 | 100.0% |
| C | 1 | 1 | 100.0% |

## Per-task breakdown

| Task | A | B | C |
|---|---|---|---|
| csv-parse-quoted | 1/1 | 1/1 | 1/1 |

## Secondary metrics

| Arm | Micro pass fraction | Escalations | Mean rounds | Mean review findings | Mean seconds |
|---|---|---|---|---|---|
| A | 100.0% | 0 | — | — | 21 |
| B | 100.0% | 0 | 1.00 | 0.00 | 24 |
| C | 100.0% | 0 | 2.00 | 0.00 | 218 |

## Tokens & cost

Metered columns are computed over metered runs only.

| Arm | Metered runs | Mean tokens (metered) | Mean cost USD (metered) | Estimated runs | character-based estimate — not comparable across arms |
|---|---|---|---|---|---|
| A | 1 | 123191 | 0.0941 | 0 | — |
| B | 1 | 124593 | 0.0984 | 0 | — |
| C | 1 | 1315725 | 1.1097 | 0 | — |

## Harness failures

None.

- Arm A: graded 1/15 scheduled
- Arm B: graded 1/15 scheduled
- Arm C: graded 1/15 scheduled

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

Rows in ledger: 3 of 45 scheduled. This report is derived from ledger.jsonl alone.
