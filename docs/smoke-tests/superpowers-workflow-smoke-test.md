# Superpowers Feature-Development Workflow Smoke Test

Covers the autonomous feature-development workflow (`WorkflowDriver` +
`applyOrchestratorVerdict` + phase templating + git integration) end-to-end.

Two tiers:

- **Mock probe** — deterministic, no LLM cost, runs in seconds. Default path for
  local verification and CI-style sanity before a release.
- **Live run** — real Codex + Claude providers through real mount panes. Burns
  tokens and is inherently flaky; run before a release when the workflow code
  surface changed.

---

## Mock probe

Runs the full workflow state machine against an embedded broker with a scripted
verdict queue. No HTTP listener, no mount panes, no real LLM.

```bash
./scripts/manual/autonomous-workflow-mock-probe.sh --scenario all
```

Scenarios:

| `--scenario` | covers |
|---|---|
| `happy`    | 4 phases all approve → `workflow.done`, `commitRange` populated |
| `findings` | spec-refining findings round 1, approve round 2 |
| `escalate` | spec-refining findings at `maxRounds=5` → `workflow.halted` with `haltReason` containing `max-rounds-reached` |
| `resume`   | halt, then `resumeWorkflow`, drive to `workflow.done`; prior phase-run row preserved with `outcome='escalated'` |
| `cancel`   | halt, then `cancelWorkflow`; `resumeWorkflow` rejects with `"canceled"` |
| `all`      | runs all five sequentially |

Exit code is non-zero on any scenario failure. Per-run artifacts land under
`.ai-whisper/manual/autonomous-workflow-mock-probe/<timestamp>/`:

- `probe-summary.txt` — scenario PASS/FAIL list + overall verdict.
- `probe-stdout.txt` — full stdout including assertion messages on failure.

### What the mock probe does NOT cover

- Real provider interaction (capture, idle clocks, permission prompts).
- Mount-pane autonomous-mode hotkey suppression.
- Recovery sweep after a real broker restart.
- CLI surface (`whisper workflow start|list|inspect|resume|cancel`) — the probe
  drives `broker.control` directly. CLI commands are unit-tested separately.

For those, run the live test below.

---

## Live run

Full end-to-end with real providers. Expect 15–30 minutes per run, ~$ of API
tokens, and occasional drift (implementer misinterprets spec, hits rate
limits, etc.). Not CI-suitable.

### Prerequisites

- `pnpm install && pnpm build` (though note: the mock probe bypasses build via
  `tsx`; live run needs the built CLI).
- `codex` and `claude` on `PATH`.
- Real `tmux`.
- Clean git workspace in target repo.

### Env

```bash
export AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=1
export AI_WHISPER_EVALUATOR_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-...
export AI_WHISPER_IDLE_THRESHOLD_MS=15000   # spec-recommended default
```

### Steps

1. Author a tiny canned spec, commit it:
   `docs/superpowers/specs/YYYY-MM-DD-hello-cli-design.md` — e.g. "add a
   `whisper hello` command that prints `hello`".
2. `node packages/cli/dist/bin/whisper.js collab start --no-launch`.
3. In two tmux/iTerm tabs — mount both providers with auto-allow permissions
   so prompts don't reset the idle clock:
   - `collab mount codex` (auto-approve)
   - `collab mount claude --dangerously-skip-permissions` (or equivalent)
4. Kick off:
   ```bash
   node packages/cli/dist/bin/whisper.js workflow start \
     --type spec-driven-development \
     --spec docs/superpowers/specs/YYYY-MM-DD-hello-cli-design.md \
     --implementer claude --reviewer codex
   ```
5. Walk away. Do NOT press `a/d/h/space/Ctrl+H` on either pane.
6. Observe from a separate terminal:
   - `whisper workflow list` — running → done.
   - `whisper workflow inspect <wf-id>` — 4 phase rows, each `outcome='done'`.
   - `whisper collab inspect` — header shows Workflow / Phase / Step / Round.
   - Optional: `whisper collab relay-monitor` — phase-started / round-started /
     phase-done events in order.

### Pass criteria

- `workflow.status = done`.
- Plan file exists: `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`.
- Commits present on branch, `pnpm test` green.
- `workflow_context.commitRange = <base>..<head>` with base ≠ head.
- 4× `workflow.phase-started`, 1× `workflow.done` in monitor log.
- Mount panes showed the minimal autonomous status line only, no hotkey hints.

### Additional live checks

- **Escalation + resume:** force `findings` past `maxRounds=5` with a
  contradictory spec. Expect `workflow.halted` and escalation banner. Then
  `whisper workflow resume <wf-id>` → fresh phase row, prior row preserved
  with `outcome='escalated'`, workflow reaches done.
- **Cancel:** on a halted run, `whisper workflow cancel <wf-id>` →
  `status=canceled`. `whisper workflow resume <wf-id>` must reject with a
  message about `canceled`.
- **Hotkey suppression:** while a workflow-owned chain is active, press
  `a/d/h/space/Ctrl+H` on the mount pane — state must not change.
- **Orchestrator gate:** start a collab with
  `AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=0`. `workflow start` must reject with
  `"workflow requires orchestrator-enabled collab"`.
- **Broker restart recovery:** kick a workflow, `kill` the broker daemon,
  restart via `collab start`. Within ~30s the recovery sweep re-kicks off the
  current phase; no duplicate phase-run rows.

### Cleanup

```bash
whisper workflow cancel <wf-id>   # if still running
whisper collab stop
```

Verify no orphan tmux session remains, no leftover broker process bound to
`:4311`.
