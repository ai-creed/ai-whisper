---
name: ai-whisper-deliberation
description: Kick off the deliberation workflow on a given seed file. Use when the user says things like "run deliberation on <path>", "deliberate on this idea <path>", "kick off deliberation with <path>", "/aiw-deliberation <path>", "$aiw-deliberation <path>", or otherwise asks to start the deliberation workflow on a specific seed file or fuzzy idea.
---

# ai-whisper-deliberation

Kick off the ai-whisper deliberation workflow on a specific seed file or fuzzy idea. This skill is fire-and-forget: it verifies the collab is ready, runs `whisper workflow start`, and exits. **Do NOT continue polling or narrating after kickoff** — continuous activity from the calling agent keeps it busy, which blocks the broker's idle detection and stalls the workflow. The dashboard (`whisper collab dashboard`) is the inspection surface during the run.

## When to invoke

Match phrases like:
- *"run deliberation on docs/idea.md"* / *"deliberate on this idea @docs/idea.md"*
- *"kick off deliberation with docs/seed.md"*
- *"/aiw-deliberation docs/seed.md"* (Claude picker form)
- *"$aiw-deliberation docs/seed.md"* (Codex picker form)

If the user references a seed file ambiguously (e.g., "run deliberation on the idea we just discussed"), ASK them for the path ONCE before proceeding. Do not guess.

## Steps

### 1. Resolve the seed path

The user names a path. If it begins with `@`, strip the `@`. Resolve to an absolute path. Verify it's a readable file via the Read tool. If not readable:

> Seed file `<path>` is not readable. Check the path and try again.

Then verify the seed is **non-empty** — the resolved file must contain an actual topic, not be empty or whitespace-only. A deliberation needs a non-empty topic to reason about (spec seed contract). If the file is empty or only whitespace, do NOT start the workflow:

> Seed file `<path>` is empty. A deliberation needs a non-empty topic — add at least a one-line idea, problem, or question to the file, then try again.

The file is a **seed** (free-form markdown or plain text): a fuzzy idea, a question, a problem statement, or a research topic — not a spec or a bug report. One line is sufficient. Project-grounded seeds (referencing specific code, docs, or existing artifacts in the repo) get the strongest deliberation result; a seed with no project anchor degrades to web-grounded research rather than being refused. This framing is guidance for preparing the seed before kickoff; it is not runtime output.

### 2. Verify collab readiness

Run:

```bash
whisper collab status --json
```

Parse the JSON. The expected shape is:

```json
{
  "collabId": "collab_xyz",
  "workspaceRoot": "/path",
  "status": "active",
  "daemon": { "host": "127.0.0.1", "port": 4311, "pid": 12345 },
  "agents": [
    { "agentType": "codex",  "bindingState": "bound" | "pending_attach" | "unbound" | null },
    { "agentType": "claude", "bindingState": "bound" | "pending_attach" | "unbound" | null },
    { "agentType": "ezio",   "bindingState": "bound" | "pending_attach" | "unbound" | null }
  ],
  "recovery": { "state": "normal" | "recovery_required" | "recovered" },
  "evaluator": { "ready": true | false, "status": "ready" | "missing_anthropic_key" | "invalid_config" | "disabled" | "unknown" }
}
```

Required for readiness:
- `daemon !== null`
- `status === "active"`
- `recovery.state === "normal"`
- **EXACTLY TWO agents bound** — among `codex`, `claude`, and `ezio`, exactly two
  must have `bindingState === "bound"` (the implementer + reviewer pair). **`ezio`
  is a replacement role**: it stands in for `codex` or `claude`, so do NOT require
  `codex` and `claude` specifically. A pair of `ezio` + `claude`, `ezio` + `codex`,
  or `codex` + `claude` all pass. (The displaced slot reads `null`/`unbound` and
  that is expected when `ezio` replaces it.)
- `evaluator.status` is NOT `"missing_anthropic_key"` or `"invalid_config"` (i.e., `ready`, `disabled`, and `unknown` all pass this gate; only the two true-misconfiguration statuses block)

If the JSON has `{ "error": "no_collab_for_cwd", ... }`:

> No collab found in this workspace. Mount any **two** agents (e.g. `whisper collab mount ezio` in one terminal and `whisper collab mount codex` — or `claude` — in another), then re-run this skill.

If `recovery.state === "recovery_required"`:

> The collab is in recovery_required state. Run `whisper collab recover`, then re-run this skill.

If `recovery.state === "recovered"`:

> The collab has been recovered and still needs reconnect. Run `whisper collab reconnect codex` and `whisper collab reconnect claude`, then re-run this skill.

If FEWER than two agents are bound (count `bindingState === "bound"` across
`codex`/`claude`/`ezio`):

> Only <N> agent(s) bound (<list bound agentTypes>). A workflow needs two — an
> implementer and a reviewer. Mount another agent (`whisper collab mount <codex|claude|ezio>`)
> in a separate terminal, then re-run this skill. `ezio` may replace `codex` or `claude`.

(Do NOT append permission flags — mount already spawns the agent in full-permission mode; passing `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` again can crash the agent on a duplicate-argument error.)

If `evaluator.status === "missing_anthropic_key"` (i.e., `evaluator.ready === false` AND status is `missing_anthropic_key`):

> The evaluator has no Anthropic API key. Create `~/.ai-whisper/auth.json` with `{ "ANTHROPIC_API_KEY": "sk-ant-..." }` (chmod 600), then restart the daemon (`whisper collab stop` and re-mount, or restart the broker), and re-run this skill. See the README "Evaluator configuration" section.

If `evaluator.status === "invalid_config"` (i.e., `evaluator.ready === false` AND status is `invalid_config`):

> The evaluator config is malformed. Fix the JSON in `~/.ai-whisper/auth.json` or `~/.ai-whisper/config.json`, then restart the daemon and re-run this skill. See the README "Evaluator configuration" section.

If `evaluator.status === "disabled"`: this means the orchestrator is intentionally off — it is NOT a misconfiguration and does NOT block this skill gate. Proceed to step 3; `workflow start` will surface the orchestrator-disabled error itself.

(Note: `evaluator.ready` is `false` for `missing_anthropic_key`, `invalid_config`, AND `disabled`; it is `true` only for `ready` and `unknown`. That's why this gate keys off `status` rather than `ready` — so `disabled` does not block the skill while the two true-misconfiguration statuses do.)

### 3. Kick off the workflow

```bash
whisper workflow start --type=deliberation --spec=<resolved-absolute-seed-path>
```

Parse the workflowId from stdout (format: `Workflow started: <workflowId>`).

### 4. Report and exit

Print exactly:

> Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

Then stop. Do NOT poll. The deliberation runs in the broker driver; your job is done.

## What deliberation does (static documentation — NEVER printed at runtime)

This section is reference prose for the invoking agent's understanding. It is documentation, not a runtime step, and must NOT be emitted after kickoff (doing so would violate the exactly-one-line report/exit contract in step 4).

Deliberation is the **pre-spec stage** for a fuzzy idea — the workflow to run when you have a hunch, a question, or an open-ended goal that is not yet crisp enough to write a spec for. The output is a **findings document** written to `docs/superpowers/deliberations/` in the project repository, NOT code. No implementation artifacts are produced.

The **seed** is a free-form file: a single line suffices, though richer context helps. Seeds that are **project-grounded** — referencing specific source files, existing docs, or concrete problems observed in the codebase — get the strongest deliberation result because the agents can trace claims directly to evidence. A seed with no project anchor (a purely abstract idea or a general question) degrades gracefully to **web-grounded research** rather than being refused (see spec §6 and §10). The findings document in that case draws from external sources and is clearly labeled as such.

Once kicked off, the workflow runs four propose→review→fix layers, each producing a committed findings artifact: (1) Objectives — the Explorer derives what the seed is really asking and why; (2) Approaches — at least three distinct approaches are surveyed and grounded; (3) Tradeoffs — each surviving approach is stress-tested for difficulty, blast radius, and real costs; (4) Synthesis — the prior layers are collapsed into a single findings document committed to `docs/superpowers/deliberations/`. At each layer, a Challenger adversarially stress-tests the Explorer's output before it advances. Watch all of this on `whisper collab dashboard`; do not babysit it from chat.

## Why fire-and-forget

The broker's relay handoff system uses **idle detection** to know when an agent is ready to receive the next handoff. If this skill polled the workflow's status every few seconds, the calling agent (you) would emit output continuously, the broker would never see you as idle, and the workflow's first handoff couldn't be delivered to you — the workflow stalls. Kick off and exit; observation belongs to the dashboard.

## Resume / cancel

If the user asks to resume a halted workflow, run:

```bash
whisper workflow resume <workflowId>
```

If they ask to cancel:

```bash
whisper workflow cancel <workflowId>
```

Same fire-and-forget shape: invoke, report one line, exit.

## Pausing the workflow (operator control)

If the user interrupts you mid-workflow and asks to pause it (e.g. "pause the workflow, I need to fix X"):

1. Find the active workflow id: `whisper workflow list`.
2. Run `whisper workflow pause <workflowId>`.
3. Acknowledge and **stop working** — do not start the next change.

The operator edits artifacts while paused, then resumes:

```bash
whisper workflow resume <workflowId> --message "what I changed and why"
```

On resume the agents receive a notice listing the changed files plus the operator note, and must re-read those files before continuing.

Provider gotcha: the Codex CLI **exits its session** on Ctrl+C at an idle prompt (a mid-task Ctrl+C only interrupts the running task). The user typically interrupts a *busy* agent before issuing the pause instruction — do not assume Ctrl+C is a safe no-op.
