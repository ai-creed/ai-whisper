# Pair-vs-solo evaluation kit

This kit measures whether the paired workflow (Arm C: Claude and Codex through the `whisper` broker) beats a single agent working alone (Arm A: one-shot solo; Arm B: solo with a mandated self-review loop) on the same 15 tasks. Design, metrics and the experimental controls are in `docs/superpowers/specs/2026-08-10-pair-vs-solo-eval-kit-design.md`; this file covers operating the runner and authoring tasks.

## Prerequisites

```bash
pnpm install && pnpm build
pnpm eval -- toolchain
```

- `pnpm eval -- toolchain` installs the pinned fixture toolchain (`eval/toolchain/`) under `--toolchain-root` (default `~/.ai-whisper-eval/toolchain`) and prints the resulting `node_modules` path. The root must be outside the repository. Every command that touches fixtures (`slice`, `run`, `grade`, `validate-tasks`, `dry-run`) installs it on demand.
- To change a toolchain pin, edit `eval/toolchain/package.json` and regenerate the lockfile with `pnpm --dir eval/toolchain install --lockfile-only --ignore-workspace`. Without `--ignore-workspace` pnpm walks up to the repo workspace and writes nothing.
- `claude` and `codex` must be on `PATH`; their versions are pinned in the manifest.
- Billing for the claude seats (solo arms and the Arm C claude mount) is pinned at `init` with `--billing`. The default, `subscription`, strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the agent environment so `claude` falls back to its claude.ai login; run `claude` once and log in first. `api` keeps the key in the agent environment and bills the Anthropic API. Before any spend, `slice` and `run` probe `claude auth status --json` with the agent environment (subscription must report `claude.ai`) or check the key is set (api) and refuse otherwise. The codex seat and the evaluator are outside this switch: codex runs on its own chatgpt login or `OPENAI_API_KEY`, and the evaluator bills its own configured provider. With an `anthropic` evaluator under `subscription`, the key must be in `~/.ai-whisper/auth.json` (or `.env` there): the mount's environment is scrubbed, so a key that lives only in the shell never reaches the broker, and the preflight refuses the slice until the file carries it.
- The evaluator must be configured (see `docs/evaluator-configuration.md`); its settings are snapshotted into the manifest at `init`. The runner copies `auth.json`, `config.json` and `.env` from the source state root (default `~/.ai-whisper`) into each Arm C state root when present.

All commands are `pnpm eval -- <command> [options]`. A leading `--` is accepted and ignored. Exit codes: 0 success, 1 usage error, 2 failed runs or validation violations, 3 pin drift or billing preflight refusal, 4 a seat hit its usage limit.

## Authoring a task

Each task is a directory `eval/tasks/<slug>/`:

```
task.md          title and three sections
meta.json        { "category": "feature|bugfix|refactor", "shape": "quick-task|spec-driven-development" }
budget.json      { "wallClockSeconds": 1800, "tokenCap": 600000 }
approach.md      quick-task only
fixture/         the starting code, copied into every workspace
grade/           held-out tests, never shown to agents
```

Rules enforced by `validate-tasks` (the source is `TASK_LAYOUT_RULES` in `eval/runner/tasks.ts`):

- `task.md` has an H1 title and exactly the sections `## Task`, `## Scope` and `## Acceptance criteria`. Any other section is rejected.
- Scope holds only bullets, and each bullet is a single bare path (backticks allowed). Put annotations in `## Task`.
- `meta.json` declares `category` and `shape`. The suite must contain 15 tasks: 8 feature, 4 bugfix, 3 refactor; 12 quick-task, 3 spec-driven-development.
- `budget.json` holds positive integers `wallClockSeconds` and `tokenCap`. Both are required. Conventional values: quick-task 1800 s / 600000 tokens, SDD 3600 s / 1500000 tokens.
- `approach.md` is required for quick-task tasks and forbidden for spec-driven-development tasks (the spec is the approved artifact). The generated quick-task brief must pass the broker's quick-task gate.
- `grade/` holds at least one `*.grade.test.ts`. Grade tests import from `../src/<module>.ts`; the runner copies them to `__grade__/` beside `src/` only at grading time. Nothing named `grade/` may exist under `fixture/`.
- Do not reveal grade code in `task.md`: no file in `fixture/`, `task.md` or `approach.md` may reference `eval/tasks` or a `grade/` path.

Fixture conventions:

- `package.json` is `private`, `type: module`, declares only the scripts `typecheck`, `lint`, `test` and no dependencies. `test` is `vitest run --exclude __grade__`. Use the default vitest include pattern.
- Also ship `tsconfig.json`, `eslint.config.mjs`, `src/`, `test/` (the fixture's own visible tests, green at baseline) and a 3-6 line `README.md`.
- No `node_modules` (the runner symlinks the shared toolchain) and no `.gitignore` (the runner writes one).
- No symbolic links anywhere in the fixture.

Validate before running anything:

```bash
pnpm eval -- validate-tasks --green
```

Without `--green` it checks layout and counts, and runs the generated quick-task brief through the broker's quick-task gate. With `--green` it also copies each fixture to a throwaway workspace, runs typecheck, lint and tests, and runs the held-out tests. It reports a violation if the fixture is not green at baseline, if `grade/` has no tests, or if the held-out tests already all pass on the untouched fixture. Prints `task suite OK` on success, exits 2 otherwise.

## Running a campaign

```bash
pnpm eval -- init --campaign pilot --implementer-model <model> --reviewer-model <model> --trials 2 --seed 7 --billing subscription
pnpm eval -- status --campaign pilot
pnpm eval -- slice --campaign pilot --arm A --task csv-parse-quoted --limit 2
pnpm eval -- run --campaign pilot --key <task>/<arm>/<trial>
```

- `init` writes `eval/results/<campaign>/manifest.json` with the seeded run order and the pins: implementer model, reviewer model, billing mode (`--billing subscription|api`, default `subscription`; accepted on `init` only), evaluator snapshot (primary and fallback) and CLI versions. It refuses to overwrite an existing campaign; pick a new `--campaign` id. `--trials` defaults to 2; the seed is random and printed if omitted.
- `status` prints pending, running, done and failed counts overall, plus done, failed and total per arm.
- `slice` runs the pending runs matching `--arm` (repeatable), `--task` (repeatable) and `--limit`. It walks the manifest in order, so Arm C keeps its seeded position. Solo runs (A, B) overlap up to `--parallel-solo` (default 2); a pair run drains the pool and runs alone. Pair runs are always serial.
- `run --key` runs one specific run.
- `--workspace-root` (default `~/.ai-whisper-eval/workspaces`) is where workspaces are created.
- Any error thrown during a run is retried once automatically (a fresh attempt directory); a second failure is recorded as a `harness failure` row and the run is marked `failed`. `slice` exits 2 if any run ended `failed`.

Usage limits: a seat that hits its account limit (claude.ai's 5-hour window, the ChatGPT plan quota behind codex) is not a result of the system under test. The runner watches both mounts' output and the solo result for the CLIs' own limit messages; on a hit it tears the run down, writes no ledger row, puts the run back to `pending` with its attempt refunded, lets in-flight solo runs finish, starts nothing new, prints the reset time the CLI reported and exits 4. Re-run the same `slice` after the limit resets.

Resuming after a crash: run the same `slice` command again. It selects only runs that are not `done`, so finished runs are not repeated. `slice` never re-runs a `failed` run (an unrecovered harness failure is recorded and counted). To retry one, re-init the campaign or hand-edit its status in `manifest.json`.

Pin drift: before each Arm C run (before any Arm C spend), `slice` and `run` compare the manifest pins against the live reviewer model, the four evaluator fields (provider, model, fallback provider, fallback model) and the CLI versions. Arm A and B runs are not guarded, so do not upgrade `claude` or `codex` mid-campaign: A/B runs would silently change. On a mismatch the runner prints each differing field and exits 3. Either restore the pinned environment (reinstall the pinned CLI versions, restore the evaluator settings) or, if the change is intended, start a new campaign. `cli_versions.whisper` is `<version>+<sha>` where the sha is the last commit touching anything outside `eval/results/`, so committing campaign results mid-campaign does not trip drift. Known limitation: a dirty working tree is not captured in the pin, so uncommitted edits to the product go unnoticed. Commit before starting a campaign.

## Dry run

```bash
pnpm eval:dry-run
```

Builds a campaign from `csv-parse-quoted` only and runs one trial per arm with fake headless and mounted agents, so there is no API spend. It prints `DRY RUN OK` only if all three rows complete, the hygiene gate is green on each, metered arms show non-zero metered usage, Arm C shows estimated usage, and the held-out tests are not all passing (the fake model must not solve the task). Otherwise it prints `DRY RUN FAILED` with the problems and exits 2. The campaign is written to `eval/results/dry-run-<timestamp>/` (manifest, ledger, report) inside the repository and nothing deletes it. Delete it after reading the result; do not commit it. The dry run always uses the default toolchain root and the default workspace root for workspaces, ignoring `--toolchain-root` and `--workspace-root` (it uses the default `~/.ai-whisper-eval/workspaces` root, which keeps the Arm C socket path short).

`slice --dry-run` and `run --dry-run` drive the real slice/run code with the same fakes, so they append fake ledger rows and mark those runs `done` permanently. Use them only on a scratch campaign id (for example `--campaign scratch`), never on a real campaign.

A passing dry run proves the plumbing, not the transcript harvesting for the real CLIs. The next step is one real smoke task: a one-trial campaign on a single cheap task, graded and reported, before committing to the full campaign.

## Grading and re-grading

Grading happens at the end of each run: the runner copies the workspace into `<workspace>.grade`, a sibling of the run's workspace outside the repo (`<workspace>.grade-regrade-*` for a re-grade; the path is recorded in `<runDir>/grade-path.txt`), restores the fixture's `package.json`, `tsconfig.json` and `eslint.config.mjs` over the agent's copies so the gate measures the task's tooling, adds the held-out tests there as `__grade__/` (the agent's workspace never sees them), runs the hygiene gate (typecheck, lint, tests) and the held-out tests, and appends a row to `ledger.jsonl`. A run succeeds iff hygiene is fully green and 100% of held-out tests pass.

To re-grade a recorded run (for example after fixing a grader bug):

```bash
pnpm eval -- grade --campaign pilot --key <task>/<arm>/<trial>
```

`grade` re-grades the run's saved workspace (the grading copy is made from it) and appends a new ledger row. The report uses the latest row per key.

## Reporting

```bash
pnpm eval -- report --campaign pilot
```

Writes `eval/results/<campaign>/report.md` from `ledger.jsonl` alone, never the manifest, so anyone with the committed ledger reproduces it. It contains the primary success rate, a per-task breakdown, secondary metrics, tokens and cost, harness failures and residual confounds.

Tokens come in two kinds. Arms A and B are metered from the agents' own usage records. Arm C is metered, with a computed cost, only when the claude transcript, the codex transcript and the evaluator diagnostics (primary and fallback groups) were all harvested. If any component is missing, Arm C falls back to a character-based estimate (characters / 4), which is not metered: it is reported in its own column and is not comparable across arms. The dry run's stubbed pair always uses the estimate. Metered columns average over metered runs only.

## Interpreting failures

- A harness failure is a fault outside the system under test: a grader crash, a missing binary, a workspace error. It is recorded with `stop_reason: harness_failure`, listed in the report's harness-failure section, and excluded from the denominator: success rate = successes / (scheduled - unrecovered harness failures).
- Product-stack failures count against the arm. For Arm C they carry a `failure_mode` tag such as `mount_bind_timeout`, `workflow_start_error`, `collab_missing` or `workflow_halted`. Budget stops (wall clock, token cap) and escalations are not failures: the run is graded as delivered and scored on its grade like any other. Only `agent_failure` and `harness_failure` force `task_success` to false.

## Secondary metrics

- Arm B `review_findings` counts the `FINDING: ` lines that the self-review protocol mandates (one per finding, per cycle, closed by `SELF-REVIEW CYCLE <n> COMPLETE: <k> findings`). `null` means the agent did not follow the protocol.
- Arm C `review_findings` counts reviewer `findings` verdicts.
- Arm A has no review step, so its value is `null`.

## Held-out isolation

Nothing an agent can reach may resolve into the repository, because the repository contains the held-out tests.

- `--workspace-root` and `--toolchain-root` must point outside the repository. The runner refuses otherwise. The checks compare physical (symlink-resolved) paths, so a symlinked directory that lands in the repo is rejected.
- Before mounting, the pair driver grants folder trust for the workspace in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted`) and `~/.codex/config.toml` (`[projects."<path>"] trust_level = "trusted"`), for both the given and the symlink-resolved path, and removes exactly what it added when the run ends; without this both CLIs block on a first-run "trust this folder?" dialog and the kickoff handoff lands on it.
- Workspaces and their `node_modules` symlink to the toolchain live under the workspace root; each Arm C state root is the short sibling `<workspace-root>/../state/<12-hex id>` (recorded in the run dir's `state-path.txt`), because the mount listens on a Unix socket under it and macOS caps socket paths at 104 bytes — a state root beside the long workspace path crashed both mounts at startup. Keep `--workspace-root` short.
- Fixtures may not contain symlinks, and fixtures and task text may not reference `eval/tasks` or `grade/`.

## Cost accounting

Metered cost prices each component at the model that actually served it, from `eval/runner/pricing.json`. Under `--billing subscription` nothing is billed per token for the claude seats, so `cost_usd` is notional: metered tokens priced at API rates, useful for comparing arms, not a bill. `report.md` says so and the ledger row carries `billing`. Subscription usage counts against the claude.ai 5-hour window, so a large solo slice can stall on rate limits; lower `--parallel-solo` or run smaller slices. Evaluator fallback attempts are priced at the fallback model. Cost is `null` whenever any model involved is missing from `pricing.json`; pinned model IDs must match its keys exactly. The `_note` in that file records the source and caveats (for example OpenAI cache-write pricing where none is listed, and Haiku prompt-size tiering). Update it, with the retrieval date, before a campaign.

## Interim reports

The primary success rate always uses the fixed `scheduled_per_arm` denominator. A partial ledger renders an `INTERIM REPORT` banner and a separate graded-only rate, which is labelled as not the primary metric. Ungraded runs count as not yet successful in the primary rate.

## Known limitations

- The token cap in Arm C is nominal: it is enforced from a character-based estimate, while Arms A and B enforce it from metered usage.
- Transcript harvesting depends on the claude and codex session file locations. The dry run cannot validate it; the real smoke task does.
- A dirty working tree is not part of the `cli_versions.whisper` pin.
- Two trials per task per arm is directional evidence, not statistical proof.
- Agents inherit the operator's claude/codex user configuration (global instructions, plugins, MCP servers, memory); sessions are not clean-room isolated. The runner only scrubs the agent environment it controls: npm/pnpm script variables (`npm_*`), `INIT_CWD`, `PWD`, `OLDPWD` and any `PATH` entries inside this repository are removed before an agent session starts.

## What is committed

`eval/results/<campaign>/manifest.json`, `ledger.jsonl` and `report.md` are committed. `eval/results/*/runs/` (raw run directories) is git-ignored, as is `eval/toolchain/node_modules/`.
