---
name: ai-whisper-bugfix
description: Kick off the complex-bug-fixing workflow on a given bug report. Use when the user says things like "run bugfix on <path>", "fix this bug report <path>", "kick off complex-bug-fixing with <path>", "/aiw-bugfix <path>", "$aiw-bugfix <path>", or otherwise asks to start the complex-bug-fixing workflow on a specific bug report.
---

# ai-whisper-bugfix

Kick off the ai-whisper complex-bug-fixing workflow on a specific bug report. This skill is fire-and-forget: it verifies the collab is ready, runs `whisper workflow start`, and exits. **Do NOT continue polling or narrating after kickoff** — continuous activity from the calling agent keeps it busy, which blocks the broker's idle detection and stalls the workflow. The dashboard (`whisper collab dashboard`) is the inspection surface during the run.

## When to invoke

Match phrases like:
- *"run bugfix on docs/bug.md"* / *"fix this bug report @docs/bug.md"*
- *"kick off complex-bug-fixing with docs/bug.md"*
- *"/aiw-bugfix docs/bug.md"* (Claude picker form)
- *"$aiw-bugfix docs/bug.md"* (Codex picker form)

If the user references a bug report ambiguously (e.g., "run bugfix on the bug we just discussed"), ASK them for the path ONCE before proceeding. Do not guess.

## Steps

### 1. Resolve the bug-report path

The user names a path. If it begins with `@`, strip the `@`. Resolve to an absolute path. Verify it's a readable file via the Read tool. If not readable:

> Bug report `<path>` is not readable. Check the path and try again.

The file is a **bug report** (markdown or plain text): symptoms, reproduction steps, and expected-vs-actual behavior — not a spec or open-ended goal. A bug report implies a human (dev or QA) already observed and reproduced the bug, so the workflow's implementer is expected to reproduce it too, not theorize from reading code. The better the reproduction in the report, the faster the diagnosis converges. This framing is guidance for preparing the bug report before kickoff; it is not runtime output.

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

Run:

```bash
whisper workflow start --type=complex-bug-fixing --spec=<resolved-absolute-path>
```

(No `--implementer` / `--reviewer` needed — the agent triggering this skill becomes the implementer and the other agent the reviewer. Pass `--implementer <agent> --reviewer <agent>` only to override. `--spec` names the bug report.)

Parse the workflowId from stdout (format: `Workflow started: <workflowId>`).

### 4. Report and exit

Print exactly this one line — it is the **only** runtime output the skill emits after kickoff:

> Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

Then stop. Do NOT poll `whisper workflow inspect`. Do NOT narrate. Do NOT print the "What it does" documentation below. The workflow runs in the broker driver; your job is done.

## What complex-bug-fixing does (static documentation — NEVER printed at runtime)

This section is reference prose for the invoking agent's understanding. It is documentation, not a runtime step, and must NOT be emitted after kickoff (doing so would violate the exactly-one-line report/exit contract in step 4).

Once kicked off, the workflow runs a fixed three-phase pipeline: **diagnosis → fix-and-verify → post-mortem**. In diagnosis, the implementer reproduces the bug themselves (a committed RED test is strongly preferred) and writes a diagnosis artifact (root cause + proposed fix + blast radius + residual risks); an adversarial reviewer independently reproduces it and refuses to open the gate until both agree the cause is proven and the fix is net-safe. In fix-and-verify, the implementer applies the approved fix, turns the reproduction GREEN, and verifies across the blast radius, while the reviewer runs an adversarial acceptance review including test-coverage adequacy. In post-mortem, the implementer records cause, fix, coverage gaps, residual risks, and lessons learned. The diagnosis and post-mortem are self-verification artifacts for the human after the run; they live in the gitignored run dir `.ai-whisper/bugfix/<workflowId>/` and are NOT committed — only the fix and the reproduction test land in the repo. Watch all of this on `whisper collab dashboard`; do not babysit it from chat.

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
