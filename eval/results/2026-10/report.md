# Pair-vs-Solo evaluation — campaign `2026-10`

| Pin | Value |
|---|---|
| implementer model | claude-sonnet-5-5 |
| reviewer model (Arm C) | — |
| evaluator | — / — (fallback: — / —) |
| billing (claude seats) | api |
| CLI versions | whisper 0.16.0+cbc0401, claude 2.1.293, codex 0.161.0 |
| run-order seed | 20261009 |

## Primary metric

Task success rate = successful runs ÷ (scheduled − unrecovered harness failures). A run succeeds iff the hygiene gate is fully green and 100% of held-out grade tests pass.

**INTERIM REPORT** — 60 of 90 scheduled runs have a ledger row; success rates use the fixed campaign denominator (ungraded runs count as not yet successful).

| Arm | Scheduled | Graded | Unrecovered harness failures | Successes | Success rate |
|---|---|---|---|---|---|
| A | 30 | 30 | 0 | 30 | 100.0% |
| B | 30 | 30 | 0 | 30 | 100.0% |
| C | 30 | 0 | 0 | 0 | 0.0% |

Interim graded-only rate (not the primary metric):

| Arm | Graded | Successes | Rate (interim) |
|---|---|---|---|
| A | 30 | 30 | 100.0% |
| B | 30 | 30 | 100.0% |
| C | 0 | 0 | — |

## Per-task breakdown

| Task | A | B | C |
|---|---|---|---|
| bug-debounce-trailing-call | 2/2 | 2/2 | 0/0 |
| bug-ini-parser-sections | 2/2 | 2/2 | 0/0 |
| bug-money-rounding | 2/2 | 2/2 | 0/0 |
| bug-path-normalize-dotdot | 2/2 | 2/2 | 0/0 |
| cli-args-subcommands | 2/2 | 2/2 | 0/0 |
| csv-parse-quoted | 2/2 | 2/2 | 0/0 |
| event-bus-wildcards | 2/2 | 2/2 | 0/0 |
| json-schema-validator-refs | 2/2 | 2/2 | 0/0 |
| lru-cache-ttl | 2/2 | 2/2 | 0/0 |
| markdown-table-render | 2/2 | 2/2 | 0/0 |
| rate-limiter-sliding | 2/2 | 2/2 | 0/0 |
| refactor-config-loader-layers | 2/2 | 2/2 | 0/0 |
| refactor-http-router-extract | 2/2 | 2/2 | 0/0 |
| refactor-report-formatter-strategy | 2/2 | 2/2 | 0/0 |
| task-scheduler-deps | 2/2 | 2/2 | 0/0 |

## Secondary metrics

| Arm | Micro pass fraction | Escalations | Mean rounds | Mean review findings | Mean seconds |
|---|---|---|---|---|---|
| A | 100.0% | 0 | — | — | 31 |
| B | 100.0% | 0 | 1.30 | 0.40 | 40 |
| C | — | 0 | — | — | — |

## Tokens & cost

Metered columns are computed over metered runs only.

| Arm | Metered runs | Mean tokens (metered) | Mean cost USD (metered) | Estimated runs | character-based estimate — not comparable across arms |
|---|---|---|---|---|---|
| A | 30 | 160492 | 0.1191 | 0 | — |
| B | 30 | 173364 | 0.1283 | 0 | — |
| C | 0 | — | — | 0 | — |

## Harness failures

None.

- Arm A: graded 30/30 scheduled
- Arm B: graded 30/30 scheduled
- Arm C: graded 0/30 scheduled

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

Rows in ledger: 60 of 90 scheduled. This report is derived from ledger.jsonl alone.
