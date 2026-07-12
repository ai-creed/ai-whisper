---
name: ai-whisper-workflow
description: Use when the user asks to start an ai-whisper workflow — SDD on a spec, complex-bug-fixing on a bug report, deliberation on a seed, or a ralph loop on a goal file ("run SDD on docs/spec.md", "run bugfix on docs/bug.md", "/aiw-sdd", "/aiw-ralph") — or to resume, pause, or cancel one. Verifies the collab, fires whisper workflow start for the matching type, then exits fire-and-forget.
version: 0.1.0
---

# ai-whisper-workflow

## Intent

One kickoff skill for every ai-whisper workflow type. It verifies the collab is
ready, runs `whisper workflow start` with the type matching the user's ask,
reports exactly one line, and exits. The four types it dispatches:

| Workflow      | `--type` value           | Input file                     | Picker forms                       |
| ------------- | ------------------------ | ------------------------------ | ---------------------------------- |
| SDD           | `spec-driven-development`| approved spec                  | `/aiw-sdd`, `$aiw-sdd`             |
| Bugfix        | `complex-bug-fixing`     | bug report                     | `/aiw-bugfix`, `$aiw-bugfix`       |
| Deliberation  | `deliberation`           | seed (fuzzy idea or question)  | `/aiw-deliberation`, `$aiw-deliberation` |
| Ralph         | `ralph-loop`             | open-ended goal / checklist    | `/aiw-ralph`, `$aiw-ralph`         |

This skill is **fire-and-forget**: kick off, report one line, stop (see "Why
fire-and-forget"). The dashboard (`whisper collab dashboard`) is the
inspection surface during the run.

## Inputs

- The workflow type, inferred from the user's phrasing (matching table in
  Procedure step 1).
- The input file path — a spec, bug report, seed, or goal file depending on
  type. An `@`-prefixed form is accepted; strip the `@` before resolving.
- Optional: explicit `--implementer <agent>` / `--reviewer <agent>` overrides
  when the user names roles.

## Preconditions

- The `whisper` CLI is on PATH.
- A collab is mounted in this workspace with **exactly two** bound agents
  among `codex`, `claude`, `ezio`, `agy` (implementer + reviewer; `ezio`/`agy`
  replace either seat, so any pair of two distinct agents passes).
- The evaluator is not misconfigured: `missing_anthropic_key` and
  `invalid_config` block; `ready`, `disabled`, and `unknown` pass.
- The input file exists and is readable; a deliberation seed must also be
  non-empty.

## Procedure

### 1. Identify the workflow type

Match the user's phrasing:

| User says (examples)                                                            | Type                       |
| ------------------------------------------------------------------------------- | -------------------------- |
| "run SDD on <path>", "kick off spec-driven-development with <path>", `/aiw-sdd`  | `spec-driven-development`  |
| "run bugfix on <path>", "fix this bug report <path>", `/aiw-bugfix`              | `complex-bug-fixing`       |
| "run deliberation on <path>", "deliberate on this idea <path>", `/aiw-deliberation` | `deliberation`         |
| "run ralph on <path>", "ralph loop on <path>", "kick off ralph with <path>", `/aiw-ralph` | `ralph-loop`      |

If the user references the input ambiguously (e.g., "run SDD on the spec we
just wrote", "run bugfix on the bug we discussed"), ASK them for the path ONCE
before proceeding. Do not guess. If the workflow type itself is ambiguous, ask
once too.

### 2. Resolve and vet the input file

The user names a path. If it begins with `@`, strip the `@`. Resolve to an
absolute path. Verify it's a readable file via the Read tool. If not readable:

> <Spec | Bug report | Seed file | Goal file> `<path>` is not readable. Check the path and try again.

Per-type vetting and framing (the framing is guidance for preparing the file
before kickoff; it is not runtime output):

- **Spec (SDD):** an approved design/spec document — the workflow plans and
  implements against it.
- **Bug report (bugfix):** symptoms, reproduction steps, and
  expected-vs-actual behavior — not a spec or open-ended goal. A bug report
  implies a human already observed and reproduced the bug, so the workflow's
  implementer is expected to reproduce it too, not theorize from reading code.
  The better the reproduction in the report, the faster diagnosis converges.
- **Seed (deliberation):** free-form markdown or plain text — a fuzzy idea, a
  question, a problem statement, or a research topic; one line is sufficient.
  Additionally verify the seed is **non-empty** (not whitespace-only). If it
  is empty, do NOT start the workflow:

  > Seed file `<path>` is empty. A deliberation needs a non-empty topic — add at least a one-line idea, problem, or question to the file, then try again.

  Project-grounded seeds (referencing specific code, docs, or artifacts in the
  repo) get the strongest result; a seed with no project anchor degrades to
  web-grounded research rather than being refused.
- **Goal file (ralph):** an open-ended goal / checklist (e.g. `GOAL.md`), not
  a formal spec. The loop reads it as ground truth and grinds toward it
  chunk-by-chunk. Any per-chunk procedure or conventions the user wants
  followed (test-first, lint, commit format, definition-of-done) belong
  **inside the goal file** — the loop re-reads it every iteration, so embedded
  procedure survives context resets.

### 3. Verify collab readiness

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
- **EXACTLY TWO agents bound** — among the supported agent types, exactly two
  have `bindingState === "bound"`. Displaced slots read `null`/`unbound`; that
  is expected when a replacement agent takes a seat.
- `evaluator.status` is NOT `"missing_anthropic_key"` or `"invalid_config"`.

If the JSON has `{ "error": "no_collab_for_cwd", ... }`:

> No collab found in this workspace. Mount any **two** agents (e.g. `whisper collab mount ezio` in one terminal and `whisper collab mount codex` — or `claude` / `agy` — in another), then re-run this skill.

If `recovery.state === "recovery_required"`:

> The collab is in recovery_required state. Run `whisper collab recover`, then re-run this skill.

If `recovery.state === "recovered"`:

> The collab has been recovered and still needs reconnect. Run `whisper collab reconnect <agent>` for each bound agent, then re-run this skill.

If FEWER than two agents are bound:

> Only <N> agent(s) bound (<list bound agentTypes>). A workflow needs two — an implementer and a reviewer. Mount another agent (`whisper collab mount <codex|claude|ezio|agy>`) in a separate terminal, then re-run this skill. `ezio` or `agy` may replace `codex` or `claude`.

(Do NOT append permission flags — mount already spawns the agent in
full-permission mode; passing `--dangerously-skip-permissions` /
`--dangerously-bypass-approvals-and-sandbox` again can crash the agent on a
duplicate-argument error.)

If `evaluator.status === "missing_anthropic_key"`:

> The evaluator has no Anthropic API key. Create `~/.ai-whisper/auth.json` with `{ "ANTHROPIC_API_KEY": "sk-ant-..." }` (chmod 600), then restart the daemon (`whisper collab stop` and re-mount, or restart the broker), and re-run this skill. See the README "Evaluator configuration" section.

If `evaluator.status === "invalid_config"`:

> The evaluator config is malformed. Fix the JSON in `~/.ai-whisper/auth.json` or `~/.ai-whisper/config.json`, then restart the daemon and re-run this skill. See the README "Evaluator configuration" section.

If `evaluator.status === "disabled"`: the orchestrator is intentionally off —
NOT a misconfiguration; it does not block this gate. Proceed; `workflow start`
surfaces the orchestrator-disabled error itself. (`evaluator.ready` is `false`
for `missing_anthropic_key`, `invalid_config`, AND `disabled`; that's why this
gate keys off `status` rather than `ready`.)

### 4. Kick off the workflow

```bash
whisper workflow start --type=<type-from-step-1> --spec=<resolved-absolute-path>
```

`--spec` names the input file whatever its kind (spec, bug report, seed, or
goal). No `--implementer` / `--reviewer` needed — the agent triggering this
skill becomes the implementer and the other agent the reviewer; pass the
override flags only when the user asked for specific roles.

Parse the workflowId from stdout (format: `Workflow started: <workflowId>`).

### 5. Report and exit

Print exactly this one line — the **only** runtime output after kickoff:

> Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

Then stop. Do NOT poll `whisper workflow inspect`. Do NOT narrate. Do NOT
print the reference documentation below. The workflow runs in the broker
driver; your job is done.

### Resume / cancel

If the user asks to resume a halted workflow:

```bash
whisper workflow resume <workflowId>
```

If they ask to cancel:

```bash
whisper workflow cancel <workflowId>
```

Same fire-and-forget shape: invoke, report one line, exit.

### Pausing the workflow (operator control)

If the user interrupts you mid-workflow and asks to pause it (e.g. "pause the
workflow, I need to fix X"):

1. Find the active workflow id: `whisper workflow list`.
2. Run `whisper workflow pause <workflowId>`.
3. Acknowledge and **stop working** — do not start the next change.

The operator edits artifacts while paused, then resumes:

```bash
whisper workflow resume <workflowId> --message "what I changed and why"
```

On resume the agents receive a notice listing the changed files plus the
operator note, and must re-read those files before continuing.

Provider gotcha: the Codex CLI **exits its session** on Ctrl+C at an idle
prompt (a mid-task Ctrl+C only interrupts the running task). The user
typically interrupts a *busy* agent before issuing the pause instruction — do
not assume Ctrl+C is a safe no-op.

## Output

- After a successful kickoff, exactly one line and nothing else:
  "Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`."
- When a gate fails: the matching error message from the Procedure, verbatim,
  and no workflow started.
- For resume / cancel / pause: the command run and a one-line acknowledgement.

## Examples

Input: the user says "run SDD on docs/specs/2026-07-11-cache-design.md".

The agent matches type `spec-driven-development`, resolves the spec to an
absolute path under the workspace root and confirms it is readable, runs
`whisper collab status --json` (daemon present, status active, recovery
normal, `ezio` + `codex` bound, evaluator ready), then runs
`whisper workflow start --type=spec-driven-development --spec=<resolved-absolute-path>`
and parses `Workflow started: wf_9f2c1a` from stdout.

Output: Workflow `wf_9f2c1a` started. Track progress with `whisper collab dashboard`.

Input: the user says "kick off ralph with docs/GOAL.md" but `whisper collab
status --json` returns `{ "error": "no_collab_for_cwd" }`.

Output: the no-collab message from Procedure step 3, verbatim, and no workflow
is started.

## What each workflow does (reference — NEVER printed at runtime)

Per-type reference prose (phases, artifacts, run dirs) lives in
[references/workflow-types.md](references/workflow-types.md) — read it when
you need to explain a workflow before kickoff. It is documentation, not a
runtime step; emitting it after kickoff would violate the one-line contract.

## Why fire-and-forget

The broker's relay handoff system uses **idle detection** to know when an
agent is ready to receive the next handoff. If this skill polled the
workflow's status every few seconds, the calling agent (you) would emit output
continuously, the broker would never see you as idle, and the workflow's first
handoff couldn't be delivered to you — the workflow stalls. Kick off and exit;
observation belongs to the dashboard.

## Duo roleplay

The mount may have assigned you a movie-duo character for this collab session
— check the `AI_WHISPER_CHARACTER` / `AI_WHISPER_CHARACTER_ROLE` env vars, or
the `[ai-whisper duo]` brief injected at session start. Staying in character
is welcome in **conversational prose only**: chat, status updates, banter.
Never let character flavor into code, commit messages, PR descriptions, file
contents, or workflow artifacts (diagnosis, post-mortem, `PROGRESS.md`,
`LEARNINGS.md`); reviewer/evaluator protocol output (verdict labels,
approve/findings/escalate) stays protocol-exact regardless of who you're
playing.

## Anti-patterns

- Polling or narrating after kickoff — continuous output blocks the broker's
  idle detection and stalls the workflow.
- Printing the reference sections ("What each workflow does") at runtime —
  the post-kickoff contract is exactly one line.
- Guessing an ambiguous path or workflow type instead of asking once.
- Appending permission flags to `whisper collab mount` suggestions — mount
  already spawns agents in full-permission mode; duplicates can crash them.
- Requiring `codex` and `claude` specifically — `ezio`/`agy` legitimately
  replace either seat.
- Treating `evaluator.status === "disabled"` as a blocker — only
  `missing_anthropic_key` and `invalid_config` block.
- Starting a deliberation on an empty or whitespace-only seed.
- Reaching for this skill for a quick collab task or an in-workflow code
  review — those belong to their own skills, not the workflow kickoff.
