---
name: ai-whisper-sdd
description: Kick off the spec-driven-development (SDD) workflow on a given spec file. Use when the user says things like "run SDD on <path>", "kick off spec-driven-development with <path>", "/aiw-sdd <path>", "$aiw-sdd <path>", or otherwise asks to start the spec-driven-development workflow on a specific spec file.
---

# ai-whisper-sdd

Kick off the ai-whisper spec-driven-development (SDD) workflow on a specific spec file. This skill is fire-and-forget: it verifies the collab is ready, runs `whisper workflow start`, and exits. **Do NOT continue polling or narrating after kickoff** — continuous activity from the calling agent keeps it busy, which blocks the broker's idle detection and stalls the workflow. The dashboard (`whisper collab dashboard`) is the inspection surface during the run.

## When to invoke

Match phrases like:
- *"run SDD on docs/spec.md"* / *"kick off spec-driven-development with @docs/spec.md"*
- *"/aiw-sdd docs/spec.md"* (Claude picker form)
- *"$aiw-sdd docs/spec.md"* (Codex picker form)

If the user references a spec ambiguously (e.g., "run SDD on the spec we just wrote"), ASK them for the path ONCE before proceeding. Do not guess.

## Steps

### 1. Resolve the spec path

The user names a path. If it begins with `@`, strip the `@`. Resolve to an absolute path. Verify it's a readable file via the Read tool. If not readable:

> Spec file `<path>` is not readable. Check the path and try again.

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
    { "agentType": "ezio",   "bindingState": "bound" | "pending_attach" | "unbound" | null },
    { "agentType": "agy",    "bindingState": "bound" | "pending_attach" | "unbound" | null }
  ],
  "recovery": { "state": "normal" | "recovery_required" | "recovered" },
  "evaluator": { "ready": true | false, "status": "ready" | "missing_anthropic_key" | "invalid_config" | "disabled" | "unknown" }
}
```

Required for readiness:
- `daemon !== null`
- `status === "active"`
- `recovery.state === "normal"`
- **EXACTLY TWO agents bound** — among the supported agent types (`codex`, `claude`,
  `ezio`, `agy`), exactly two must have `bindingState === "bound"` (the implementer +
  reviewer pair). **`ezio` and `agy` are replacement roles**: either stands in for
  `codex` or `claude`, so do NOT require `codex` and `claude` specifically — any
  pair of two distinct supported agents passes. (The `agents` array may list all
  supported types; the displaced slots read `null`/`unbound` and that is expected
  when a replacement agent takes a seat.)
- `evaluator.status` is NOT `"missing_anthropic_key"` or `"invalid_config"` (i.e., `ready`, `disabled`, and `unknown` all pass this gate; only the two true-misconfiguration statuses block)

If the JSON has `{ "error": "no_collab_for_cwd", ... }`:

> No collab found in this workspace. Mount any **two** agents (e.g. `whisper collab mount ezio` in one terminal and `whisper collab mount codex` — or `claude` / `agy` — in another), then re-run this skill.

If `recovery.state === "recovery_required"`:

> The collab is in recovery_required state. Run `whisper collab recover`, then re-run this skill.

If `recovery.state === "recovered"`:

> The collab has been recovered and still needs reconnect. Run `whisper collab reconnect <agent>` for each bound agent, then re-run this skill.

If FEWER than two agents are bound (count `bindingState === "bound"` across
the supported agent types):

> Only <N> agent(s) bound (<list bound agentTypes>). A workflow needs two — an
> implementer and a reviewer. Mount another agent (`whisper collab mount <codex|claude|ezio|agy>`)
> in a separate terminal, then re-run this skill. `ezio` or `agy` may replace `codex` or `claude`.

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
whisper workflow start --type=spec-driven-development --spec=<resolved-absolute-path>
```

(No `--implementer` / `--reviewer` needed — the agent triggering this skill becomes the implementer and the other agent the reviewer. Pass `--implementer <agent> --reviewer <agent>` only to override.)

Parse the workflowId from stdout (format: `Workflow started: <workflowId>`).

### 4. Report and exit

Print exactly:

> Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

Then stop. Do NOT poll `whisper workflow inspect`. Do NOT continue narrating. The workflow runs in the broker driver; your job is done.

## Why fire-and-forget

The broker's relay handoff system uses **idle detection** to know when an agent is ready to receive the next handoff. If this skill polled the workflow's status every few seconds, the calling agent (you) would emit output continuously, the broker would never see you as idle, and the workflow's first handoff couldn't be delivered to you — the workflow stalls. Kick off and exit; observation belongs to the dashboard.

## Duo roleplay

The mount may have assigned you a movie-duo character for this collab session — check the `AI_WHISPER_CHARACTER` / `AI_WHISPER_CHARACTER_ROLE` env vars, or the `[ai-whisper duo]` brief injected at session start, to find out. If so, staying in character is welcome — but **conversational prose only**: chat, status updates, banter with the operator or your teammate.

Never let character flavor into code, commit messages, PR descriptions, or file contents. The reviewer/evaluator protocol output (verdict labels, approve/findings/escalate) stays protocol-exact regardless of who you're playing.

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
