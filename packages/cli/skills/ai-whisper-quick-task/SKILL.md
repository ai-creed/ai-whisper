---
name: ai-whisper-quick-task
description: Use when the user asks to start, resume, cancel, or pause an ai-whisper quick-task — a small, already-approved unit of work — in any phrasing, terse included ("quick task", "run quick task on <path or task>", "start the quick-task workflow", "write the brief and start quick-task", "$aiw-quick-task") — writes the four-section task brief, verifies collab readiness, and fires whisper workflow start without polling afterward.
version: 0.1.0
---

# ai-whisper-quick-task

## Intent

Kick off the ai-whisper quick-task workflow on a small, already-approved unit
of work. This skill is fire-and-forget: it verifies the collab is ready, runs
`whisper workflow start`, and exits. The dashboard (`whisper collab
dashboard`) is the inspection surface during the run.

Unlike `ai-whisper-sdd`, which kicks off against a spec someone already
wrote, this skill also **writes the task brief itself** (Procedure steps 1–2)
from an approach approved earlier in the conversation.

**Do NOT continue polling or narrating after kickoff.** The broker's relay
handoff system uses idle detection to know an agent is ready for its next
handoff; continued output (status polls, narration) keeps the calling agent
looking busy, so the first handoff never gets delivered and the workflow
stalls.

## Inputs

One of:
- A path to an existing brief (e.g. "run quick task on `docs/notes.md`", or
  picker forms "/aiw-quick-task docs/notes.md" / "$aiw-quick-task
  docs/notes.md").
- An inline task with no brief file yet (e.g. "run quick task: fix the
  off-by-one in the pagination helper"), approach already discussed.
- For resume/cancel/pause: a `workflowId` (`whisper workflow list` if
  unknown), plus an optional operator note for resume.

Ambiguous references are fine pre-approval — proceed to Procedure step 1.
Do not guess at scope or approach.

## Preconditions

- The task is executable now under an already-agreed approach — no
  unresolved research, design decision, or schema migration (else step 1
  refuses).
- The collab is active and ready: daemon up, status active, recovery
  normal, two supported agents bound, evaluator not misconfigured (gate
  detail in step 3).
- `.ai-whisper/tasks/` may not exist yet; step 2 creates it without
  clobbering an existing `.gitignore`.

## Procedure

### 1. Executability pre-check

Quick-task is for work that is executable right away — a small, scoped
change to a codebase you already understand, with an approach already
agreed. Before doing anything else, check whether the task actually needs:
- **research** — unknowns that require investigation before a design is even
  possible,
- **unsettled design decisions** — multiple viable approaches not yet chosen
  between, or
- **schema/contract migrations** — breaking changes to a shared data shape,
  API, or wire format.

If any of these apply, REFUSE this workflow and recommend
spec-driven-development (or deliberation first, if the idea itself still
needs sharpening):

> This needs more upfront design than quick-task is for. I'd recommend
> spec-driven-development instead — write a spec and kick off SDD (or run
> deliberation first if the idea needs sharpening).

If the approach was never explicitly approved by the user in this
conversation, ask ONCE for approval before proceeding:

> Before I kick off quick-task: here's the approach I'd take — <approach>.
> Approve it and I'll write the brief and start the workflow.

Never invent an approach and kick off in the same breath. The human approves
the approach in chat; the workflow's implementer must not redesign it.

### 2. Write or resolve the brief

If the user gave a path to an existing brief, resolve it to an absolute path
and verify it's a readable file via the Read tool. If not readable:

> Task brief `<path>` is not readable. Check the path and try again.

Otherwise, write the brief yourself from the approach approved in step 1.
Create the `.ai-whisper/tasks/` directory first if it doesn't already exist,
and make sure `.ai-whisper/` is gitignored — this workflow has no broker
setup step to do it for you, so do it here (create only if absent; never
clobber an existing file):

```bash
mkdir -p .ai-whisper/tasks
[ -f .ai-whisper/.gitignore ] || printf '*\n' > .ai-whisper/.gitignore
```

Then write the brief to `.ai-whisper/tasks/<YYYY-MM-DD>-<slug>.md` (slug
derived from the task title, kebab-case).

Embed this template VERBATIM:

```markdown
# Task: <short title>

## Task
<what + why, 2–5 lines>

## Approved approach
<the approach the human approved in chat — the implementer must not redesign it>

## Scope
- `path/to/file-a.ts`
- `path/to/file-b.ts`
- `test/file-a.test.ts`

## Acceptance checks
- <how the reviewer verifies: commands to run, expected behavior>
```

`whisper workflow start` enforces a hard gate on this brief: all four
sections above (`## Task`, `## Approved approach`, `## Scope`, `## Acceptance
checks`) are required and must be non-empty; `## Scope` must list every file
the task touches, one bullet per file; and at most 5 non-test files (test
files are uncounted).

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

If `evaluator.status === "disabled"`: this means the orchestrator is intentionally off — it is NOT a misconfiguration and does NOT block this skill gate. Proceed to step 4; `workflow start` will surface the orchestrator-disabled error itself.

(Note: `evaluator.ready` is `false` for `missing_anthropic_key`, `invalid_config`, AND `disabled`; it is `true` only for `ready` and `unknown`. That's why this gate keys off `status` rather than `ready` — so `disabled` does not block the skill while the two true-misconfiguration statuses do.)

### 4. Kick off the workflow

Run:

```bash
whisper workflow start --type=quick-task --spec=<resolved-absolute-path>
```

(No `--implementer` / `--reviewer` needed — the agent triggering this skill becomes the implementer and the other agent the reviewer. Pass `--implementer <agent> --reviewer <agent>` only to override.)

If the scope gate rejects the brief, `whisper workflow start` exits non-zero and prints every violation together. Relay these violations to the user VERBATIM and STOP — do NOT silently rewrite or shrink the `## Scope` list to squeeze under the cap. The user decides whether to split the task into smaller pieces or escalate to spec-driven-development.

Otherwise, parse the workflowId from stdout (format: `Workflow started: <workflowId>`).

### 5. Report and exit

Produce the message described in the Output section, then stop. Do NOT poll `whisper workflow inspect`. Do NOT continue narrating. The workflow runs in the broker driver; your job is done.

### Variant: resume or cancel

If the user asks to resume a halted workflow, run:

```bash
whisper workflow resume <workflowId>
```

If they ask to cancel:

```bash
whisper workflow cancel <workflowId>
```

Same fire-and-forget shape: invoke, report one line, exit.

### Variant: pause (operator control)

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

## Output

- On successful kickoff, print exactly:

  > Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

  Then stop.
- On refusal, a blocked readiness check, or a rejected scope gate (Procedure
  steps 1, 3, 4): the quoted message at that step, verbatim — no workflow
  started.
- On resume/cancel/pause: a one-line report (pause also means stop working
  until the operator resumes).
- A duo character may be assigned (`AI_WHISPER_CHARACTER` env vars, or an
  `[ai-whisper duo]` session brief) — fine in conversational replies; see
  Anti-patterns for where it must not appear.

## Examples

Input: "run quick task: the pagination helper is off-by-one on the last
page, fix it in `src/pagination.ts`" — approach already approved earlier:
"clamp the computed page count to at least 1 before using it in the offset
calculation."

Step 1: nothing unresolved; approach already approved — no re-ask. Step 2
writes `.ai-whisper/tasks/2026-07-10-fix-pagination-off-by-one.md`:

```markdown
# Task: Fix pagination off-by-one on last page

## Task
The pagination helper computes an out-of-range offset on the last page
because the page count can resolve to 0.

## Approved approach
Clamp the computed page count to at least 1 before using it in the offset
calculation.

## Scope
- `src/pagination.ts`
- `test/pagination.test.ts`

## Acceptance checks
- `npm test -- pagination` passes.
- Requesting the last page with a small result set no longer returns an
  empty page.
```

Step 3 confirms readiness (`active`, normal recovery, `claude` + `codex`
bound, evaluator `ready`). Step 4 runs `whisper workflow start
--type=quick-task
--spec=/abs/path/.ai-whisper/tasks/2026-07-10-fix-pagination-off-by-one.md`
→ `Workflow started: wf_9f21c`.

Output (step 5): "Workflow `wf_9f21c` started. Track progress with `whisper
collab dashboard`." — nothing further.

## Anti-patterns

- Polling `whisper workflow inspect` or narrating after kickoff (see Intent).
- Inventing an approach and kicking off in the same breath, skipping
  approval (Procedure step 1).
- Shrinking a brief's `## Scope` to fit the 5-file cap instead of relaying
  scope-gate violations verbatim and letting the user decide.
- Treating `evaluator.status: "disabled"` as a blocker — intentional, not a
  misconfiguration.
- Appending permission flags to a `mount` suggestion — already
  full-permission; a duplicate flag can crash the agent.
- Assuming a Codex agent's Ctrl+C is a safe no-op when pausing — it exits
  the session at an idle prompt.
- Letting duo-roleplay voice leak into code, commits, PRs, or
  reviewer/evaluator protocol output — that stays protocol-exact.
