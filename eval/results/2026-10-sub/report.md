# Pair-vs-Solo evaluation — campaign `2026-10-sub`

| Pin | Value |
|---|---|
| implementer model | claude-sonnet-5-5 |
| reviewer model (Arm C) | gpt-5.6-sol |
| evaluator | anthropic / — (fallback: — / —) |
| billing (claude seats) | subscription |
| CLI versions | whisper 0.16.0+afcc9bb, 0.16.0+3014f22, 0.16.0+660243c ⚠ mixed, claude 2.1.293, codex 0.161.0, 0.162.0 ⚠ mixed |
| run-order seed | 20261009 |

## Primary metric

Task success rate = successful runs ÷ (scheduled − unrecovered harness failures). A run succeeds iff the hygiene gate is fully green and 100% of held-out grade tests pass.

**INTERIM REPORT** — 30 of 90 scheduled runs have a ledger row; success rates use the fixed campaign denominator (ungraded runs count as not yet successful).

| Arm | Scheduled | Graded | Unrecovered harness failures | Successes | Success rate |
|---|---|---|---|---|---|
| A | 30 | 0 | 0 | 0 | 0.0% |
| B | 30 | 0 | 0 | 0 | 0.0% |
| C | 30 | 30 | 0 | 25 | 83.3% |

Interim graded-only rate (not the primary metric):

| Arm | Graded | Successes | Rate (interim) |
|---|---|---|---|
| A | 0 | 0 | — |
| B | 0 | 0 | — |
| C | 30 | 25 | 83.3% |

## Per-task breakdown

| Task | A | B | C |
|---|---|---|---|
| bug-debounce-trailing-call | 0/0 | 0/0 | 2/2 |
| bug-ini-parser-sections | 0/0 | 0/0 | 2/2 |
| bug-money-rounding | 0/0 | 0/0 | 2/2 |
| bug-path-normalize-dotdot | 0/0 | 0/0 | 1/2 |
| cli-args-subcommands | 0/0 | 0/0 | 2/2 |
| csv-parse-quoted | 0/0 | 0/0 | 2/2 |
| event-bus-wildcards | 0/0 | 0/0 | 2/2 |
| json-schema-validator-refs | 0/0 | 0/0 | 0/2 |
| lru-cache-ttl | 0/0 | 0/0 | 2/2 |
| markdown-table-render | 0/0 | 0/0 | 2/2 |
| rate-limiter-sliding | 0/0 | 0/0 | 2/2 |
| refactor-config-loader-layers | 0/0 | 0/0 | 0/2 |
| refactor-http-router-extract | 0/0 | 0/0 | 2/2 |
| refactor-report-formatter-strategy | 0/0 | 0/0 | 2/2 |
| task-scheduler-deps | 0/0 | 0/0 | 2/2 |

## Secondary metrics

| Arm | Micro pass fraction | Escalations | Mean rounds | Mean review findings | Mean seconds |
|---|---|---|---|---|---|
| A | — | 0 | — | — | — |
| B | — | 0 | — | — | — |
| C | 83.6% | 6 | 2.77 | 0.00 | 378 |

## Tokens & cost

Metered columns are computed over metered runs only.

Cost USD is **notional** for subscription-billed rows: metered tokens priced at the API rates in `pricing.json`, nothing was billed per token for the claude seats. The Arm C evaluator bills its own configured provider (the Anthropic API key in the state root's auth.json for `anthropic`), so that share of an Arm C row is real spend.

| Arm | Metered runs | Mean tokens (metered) | Mean cost USD (metered) | Estimated runs | character-based estimate — not comparable across arms |
|---|---|---|---|---|---|
| A | 0 | — | — | 0 | — |
| B | 0 | — | — | 0 | — |
| C | 29 | 2356220 | 1.8654 | 1 | 665 |

## Harness failures

None.

- Arm A: graded 0/30 scheduled
- Arm B: graded 0/30 scheduled
- Arm C: graded 30/30 scheduled

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

Rows in ledger: 30 of 90 scheduled. This report is derived from ledger.jsonl alone.
