# Relay Handoff Flows

ai-whisper uses a turn-based relay between two mounted agent panes (any two of `claude`, `codex`, and `ezio`). A "handoff" is one unit of that turn — a request from a sender to a target, optionally judged by an orchestrator and either resolved, looped, or escalated.

This document explains the two flows the relay supports today:

1. [Manual chats](#1-manual-chats) — free-form back-and-forth driven by you, the operator
2. [Autonomous workflows](#2-autonomous-workflows) — multi-phase pipelines like `spec-driven-development` driven by the broker

Both flows share the same handoff state machine, the same idle auto-fire timing, and the same orchestrator. They differ in **who decides** what each verdict means.

---

## Concepts shared by both flows

### Handoff lifecycle

```
   sender                                            target
     │                                                 │
     │  createRelayHandoff (request_text, status=pending)
     │ ──────────────────────────────────────────────► │
     │                                                 │
     │              [target accepts]                   │
     │                                                 │
     │                                                 ├── status=accepted
     │                                                 │   PTY: request_text written + Enter
     │                                                 │
     │                                                 │   target produces response
     │                                                 │
     │              [target hands back]                │
     │                                                 │
     │                                                 ├── status=handed_back
     │                                                 │   handback_text captured
     │                                                 │   captureStatus classified
     │                                                 │
     │           [orchestrator (if enabled)]           │
     │                                                 │
     │  next handoff (or chain resolved/escalated)     │
     │ ◄────────────────────────────────────────────── │
```

A handoff has these states: `pending` → `accepted` → `handed_back`. After handback the orchestrator inspects it and either resolves the chain, creates a follow-up handoff, or escalates.

### Idle auto-fire

The mounted pane checks every 1s. After your terminal has been idle for `AI_WHISPER_IDLE_THRESHOLD_MS` (default 30s, min 5s), `checkIdleActions` runs:

- **Auto-accept**: if there is a pending handoff for this agent, write its `request_text` into the PTY and submit. Sets `status=accepted`.
- **Auto-handback**: if there is an accepted handoff aged ≥ 30s and the assistant turn-capture saw a visible reply, capture handback text via `/copy` (clipboard) + PTY scrape, classify the capture, and send the next handoff back to the original sender.

Both auto-fires are guarded against double-firing per handoff. Either is preempted by a manual hotkey.

### Hotkeys (manual override)

When the owner card is showing in your pane:

| key       | action                                                       | when active                           |
|-----------|--------------------------------------------------------------|---------------------------------------|
| `a` / `A` | accept pending handoff (writes request_text + Enter)         | pending handoff for this agent        |
| `e` / `E` | amend: opens composer prefilled with request_text            | pending handoff                        |
| `d` / `D` | decline pending handoff (chain ends)                         | pending handoff                        |
| `space`   | defer pending handoff (stays pending; auto-accept disarms)   | pending handoff                        |
| `h` / `H` | hand back accepted handoff (opens composer for reply)        | accepted handoff aged ≥ 30s + visible turn |
| `Ctrl+H`  | force handback now, bypassing the 30s + visible-turn gates   | accepted handoff (any age)            |

In autonomous mode all of these are **no-ops** — the broker drives the chain, you can only observe.

### Capture classification (`captureStatus`)

When auto-handback fires, the next handoff carries a `captureStatus`:

| status                            | when                                                                         | downstream effect                          |
|-----------------------------------|------------------------------------------------------------------------------|--------------------------------------------|
| `ok`                              | clipboard ≥ 100 chars, OR short clipboard + high PTY confidence + jaccard ≥ 0.6 (or containment ≥ 0.8) | request_text = clipboard; orchestrator judges normally |
| `no_response_captured_confidently`| clipboard short + PTY signal weak                                            | request_text = ""; orchestrator forces re-issue (see max-rounds) |
| `no_response_captured`            | clipboard empty AND PTY empty                                                | same as above                              |

The `/copy` step matters: it's what populates the clipboard. Some agent prompts include `/copy` automatically; in free-form chats you usually need to do it yourself.

### Orchestrator and max-rounds

A per-collab orchestrator polls every 1s for handed-back handoffs and emits a verdict. It is on by default — `whisper collab start` sets `orchestratorEnabled=true` unless `AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=0` is exported before startup. Each chain has a `max_rounds` (default 3, overridable via `AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS` at start time).

Autonomous workflows require `orchestratorEnabled=true`; `whisper workflow start` throws if the collab was started with the orchestrator disabled.

The orchestrator enforces max-rounds **before** anything else: a chain at `roundNumber >= maxRounds` always escalates, even if the handback couldn't be captured. (Without this, persistent capture failures would loop the chain forever.)

The orchestrator emits **legacy verdicts** for manual chains (`done`, `loop`, `escalate`) and **workflow verdicts** for workflow chains (`approve`, `findings`, `delivered`, `execution-pass`, `execution-fail`, `escalate`). The branch is picked by the chain's workflow metadata.

### Stale handoffs

A pending or accepted handoff aged ≥ 5 min is marked stale by the mount pane. The chain stops driving and you'll need to start a new handoff or workflow.

---

## 1. Manual chats

A manual chat is a relay handoff started by you outside any workflow. Use this when you want two agents to talk to each other turn-by-turn, or to send a one-off request.

### Starting a manual handoff

```bash
whisper collab tell <agent> "<message>"
```

This creates a pending handoff from the *other* agent to `<agent>`. Example: `whisper collab tell claude "tell me a joke"` puts a "tell me a joke" handoff in claude's pane, sender = codex.

### Per-handoff flow

```
   you                                          claude pane                     codex pane
    │                                                │                              │
    │  whisper collab tell claude "tell me a joke"   │                              │
    │ ──────────────────────────────────────────────►│ pending handoff card         │
    │                                                │                              │
    │  [press a — or wait 30s for auto-accept]       │                              │
    │                                                │                              │
    │                                                │ status=accepted              │
    │                                                │ "tell me a joke" → PTY       │
    │                                                │ claude responds              │
    │                                                │                              │
    │  /copy in claude's terminal                    │                              │
    │  (so the clipboard holds the joke text)        │                              │
    │                                                │                              │
    │  [stay idle 30s — or press h]                  │                              │
    │                                                │                              │
    │                                                │ checkIdleActions:            │
    │                                                │ - read clipboard             │
    │                                                │ - classify → captureStatus   │
    │                                                │ - handoffBackRelay           │
    │                                                │                              │ pending handoff card
    │                                                │                              │ (joke text as request)
    │                                                │                              │
    │                                                │                              │ [orchestrator judges]
```

### What the orchestrator does

Each handed-back handoff is judged with the **legacy** prompt (`done | loop | escalate`):

- `done`: the response addresses the request — chain resolved, no further handoff.
- `loop`: response incomplete or off-topic — orchestrator creates a follow-up handoff back to the responder; round counter increments.
- `escalate`: explicit blocker or contradictory request — chain escalates, no further handoff.

A bad capture (`captureStatus != "ok"`) bypasses the LLM and forces a re-issue automatically, but only while `roundNumber < maxRounds`. Once the round counter hits `maxRounds`, the chain escalates regardless of capture.

### What you'll see

- **Pending handoff card** in the target's pane showing the request text and hotkey hint `[a] accept  [e] amend  [d] decline  [space] defer`.
- **"Ready to hand back" card** once the handoff is accepted, aged ≥ 30s, and a visible turn has been captured. Hint: `[h] hand back`.
- Cards are cleared when you act, when auto-fire fires, or when the handoff resolves.

### Tips

- **Always `/copy`** if you want the response captured. Without it, the clipboard stays empty, capture is `no_response_captured_confidently`, and the orchestrator forces a re-issue (until max-rounds escalates).
- **Use `Ctrl+H`** if you need to force a handback before the 30s grace period — useful when you know the response is ready and don't want to wait.
- **`space` to defer** if you're not ready for the agent to act on the request yet. The handoff stays pending and auto-accept stops trying. Press `a` to accept it later.
- **Watch the relay-monitor** (`whisper collab relay-monitor`) for chain status, current round / max-rounds, and turn ownership.

---

## 2. Autonomous workflows

An autonomous workflow is a multi-phase pipeline that drives both agents through a structured task. Five types are registered today — `spec-driven-development`, `ralph-loop`, `complex-bug-fixing`, `deliberation`, and `quick-task`. They share the same relay and evaluator machinery and differ in their phases, artifacts, and evaluator keys; this section walks through `spec-driven-development` as the worked example, then [Other workflow types](#other-workflow-types) maps the rest onto the same model. For when to reach for each, see [Workflows](workflows.md).

### Starting a workflow

```bash
whisper workflow start \
  --type spec-driven-development \
  --spec docs/path/to/spec.md
```

The agent you run this from becomes the implementer and the other agent the reviewer. Add `--implementer <agent> --reviewer <agent>` to choose roles explicitly; run with neither flag outside a mounted session and it falls back to the workflow type's default pairing (with a warning).

This creates the workflow row, kicks off phase 0, and seeds the first handoff.

### The four phases

```
    ┌──────────────────┐  approve   ┌──────────────────┐  delivered  ┌────────────────────┐  exec-pass  ┌──────────────────┐
    │ 0: spec-refining │ ─────────► │ 1: plan-writing  │ ──────────► │ 2: plan-execution  │ ──────────► │ 3: code-review   │ → done
    │   (review-loop)  │            │   (review-loop)  │             │   (execution-gate) │             │   (review-loop)  │
    │   maxRounds=5    │            │   maxRounds=5    │             │   maxRounds=1      │             │   maxRounds=5    │
    └──────────────────┘            └──────────────────┘             └────────────────────┘             └──────────────────┘
            │                               │                                  │                               │
            │ findings/escalate             │ findings/escalate                │ exec-fail/escalate            │ findings/escalate
            ▼                               ▼                                  ▼                               ▼
         halt or                         halt or                            halt                            halt or
         loop within phase               loop within phase                                                  loop within phase
```

| phase            | initial step | implementer artifact | reviewer | maxRounds | evaluator key   |
|------------------|--------------|----------------------|----------|-----------|-----------------|
| 0 spec-refining  | review       | (the spec file)      | codex    | 5         | review-loop     |
| 1 plan-writing   | implement    | plan.md              | codex    | 5         | review-loop     |
| 2 plan-execution | execute      | commits              | (none)   | 1         | execution-gate  |
| 3 code-review    | review       | commit-range         | codex    | 5         | review-loop     |

### Per-step verdicts

| step       | allowed verdicts                              | what happens next                                   |
|------------|-----------------------------------------------|-----------------------------------------------------|
| `review`   | `approve` / `findings` / `escalate`           | approve → advance phase; findings → `fix` step (round++); escalate → halt |
| `implement`| `delivered` / `escalate`                      | delivered → `review` step (round++); escalate → halt |
| `fix`      | `delivered` / `escalate`                      | delivered → `review` step (round++); escalate → halt |
| `execute`  | `execution-pass` / `execution-fail` / `escalate` | execution-pass → next phase (or review step); execution-fail → halt; escalate → halt |

The orchestrator picks the prompt and schema based on `(evaluatorPromptKey, handoffStep)` so each step only accepts its own verdict vocabulary.

### Other workflow types

The same `(evaluatorPromptKey, handoffStep)` dispatch drives all five registered workflows — only the phases, artifacts, and keys differ. Four evaluator keys exist:

| evaluator key | verdict vocabulary | used by |
|---------------|--------------------|---------|
| `review-loop` | `approve` / `findings` / `escalate` | every review phase of `spec-driven-development` (spec-refining, plan-writing, code-review), all three phases of `complex-bug-fixing` (diagnosis, fix-and-verify, post-mortem), **and** `quick-task`'s single implement-and-review phase |
| `execution-gate` | `execution-pass` / `execution-fail` / `escalate` | `spec-driven-development` plan-execution only |
| `ralph-loop` | `approve` / `findings` / `escalate` | `ralph-loop`'s open-ended iteration phase, plus its final acceptance review against the goal |
| `deliberation-loop` | `approve` / `findings` / `escalate` | all four `deliberation` layers (objectives → approaches → tradeoffs → synthesis) |

These workflows reuse the same `review` / `implement` / `fix` steps and verdicts as the table above; what changes is the prompt behind the key. `deliberation-loop` is the sharpest case: it shares the review verdict space but runs a stricter prompt that classifies a *hollow* Challenger approval — agreement by recall, with no independent derivation and no external verification — as `findings` rather than `approve`, so a layer cannot pass on a rubber-stamp. For each workflow's phase shape and when to reach for it, see [Workflows](workflows.md).

### Auto-fire behaviour in autonomous mode

Same idle path as manual chats, with two differences:

1. **Hotkeys disabled**: `a / e / d / h / space / Ctrl+H` are no-ops while the workflow is running and the chain is active. You cannot interfere mid-flight.
2. **Owner card simplified**:
   - Pending handoff card shows `handoff pending (auto-accept)` (no hotkey hint).
   - Accepted-ready handoff card is **hidden entirely** (auto-handback fires within ~1s of readiness; the card has no operator action).

If the workflow halts (escalate or execution-fail) the chain status flips and the cards/hotkeys revert to normal manual mode — you can recover the run by inspecting `halt_reason` and starting a new workflow or unhalting manually.

### What the implementer / reviewer should do in their pane

The agents themselves run inside their respective panes. The kickoff text the broker puts in their prompt tells them what to do for each step. Typically:

- **review**: read the artifact (spec / plan / commits), reply with either an approval, a list of findings, or an escalation. The orchestrator classifies your reply.
- **implement / fix**: do the work, run `/copy` of your final summary so the auto-handback captures it (`captureStatus="ok"` matters for orchestrator confidence).
- **execute**: run the build / tests / lints, hand back with commit SHAs and outcome. Include the commit SHAs in your handback text — the orchestrator extracts them via regex for the workflow context.

### When something stalls

| symptom                                            | likely cause                                                           | what to check                                                                                                       |
|----------------------------------------------------|------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| Pending handoff sits in agent pane forever         | auto-accept guard tripped (paused, double-fire guard, etc.)            | check `AI_WHISPER_IDLE_THRESHOLD_MS`; check that the agent isn't actively typing                                    |
| Accepted handoff never hands back                  | `/copy` never ran, capture confidence too low to fire auto-handback    | `/copy` manually then idle 30s; or press `Ctrl+H` to force                                                          |
| Workflow halts with `illegal-step-verdict: <verdict>` | LLM returned a verdict not allowed for the current step                | check evaluator prompt for that step; verify the workflow evaluator is wired (was a real bug fixed in commit 72bc394) |
| Workflow halts on real test failure                | the executor itself reported a fail                                    | look at `workflows.halt_reason` in `~/.ai-whisper/state.db` — that's the orchestrator's stated reason                |
| Manual chain runs forever                          | persistent bad capture; no orchestrator escalation                     | should not happen post commit 47c0f11; if it does, inspect `relay_handoff.capture_status` and `round_number`        |

### Inspecting state

Where to look when you need ground truth:

- **Relay monitor pane**: `whisper collab relay-monitor` — live status of turn owner, chain state, current round, max rounds, workflow phase/step.
- **SQLite**: `~/.ai-whisper/state.db` (single shared store across all collabs; root overridable via `AI_WHISPER_STATE_ROOT`) — `workflows`, `relay_chains`, `relay_handoff`. `evaluator_verdict` column carries the workflow verdict; `orchestrator_verdict` is a legacy bookkeeping mapping. `halt_reason` on `workflows` is what the orchestrator used to stop.
- **CLI**: `whisper workflow inspect <workflowId>` lists phase runs and their outcomes.
- **Dashboard**: `whisper collab dashboard` — live wall of recently-active collabs + per-run inspector.

### Seeing every run with `--all`

By default the Wall shows **one card per collab** (its running-or-latest run), so
sibling runs in the same collab are masked and the footer counts collabs. To see
**one card per workflow run** instead, use:

```bash
whisper collab dashboard --all              # every run active within the window
whisper collab dashboard --all --window all # the complete run ledger (every run)
```

`--all` respects `--window` at the run level: a run shows if it is running or
paused, or its own latest activity (or, for a run with no handoffs, its creation
time) falls within the window. Paused runs always appear, grouped under ACTIVE
with the `‖` glyph. Each card inspects its own run. `--all` covers workflow runs
only; manual relay chats appear in the default view as before.

### Acting on a run from the dashboard

The Wall and the Inspector are no longer read-only. With a run selected on the
Wall (or while inspecting one), press:

- `p` — pause a running workflow
- `r` — resume a paused or halted workflow
- `c` — cancel a non-terminal workflow

Every action asks for confirmation first (`Pause wf_… ? (y/n)` — `y`/`Enter`
confirms, `n`/`Esc` dismisses); while the prompt is up, all other keys are
ignored. Keys that don't apply to the selected run (e.g. `p` on an already-paused
run, or any action on a card with no workflow) show a short hint instead and do
nothing. The result — success or the broker's error message — appears on a status
line for a few seconds. Actions call the broker in-process; there is no separate
`whisper workflow …` step.

The header line above the cards summarizes the current view at a glance:
`● N running ‖ N paused ⚠ N stuck ✓ N done ✖ N canceled ◌ N idle`. The counts
cover every run in the current scope (they respect `--all`/`--window` and span all
pages), not just the cards on the current page.

---

## State machine reference

Compact view of legal handoff transitions:

```
pending  ─[accept]──► accepted  ─[hand back]──► handed_back
   │                     │                          │
   │                     │                          ├─[orchestrator: done]──► chain resolved
   │                     │                          │
   │                     │                          ├─[orchestrator: loop / findings / delivered / exec-pass]──► new pending handoff (round++)
   │                     │                          │
   │                     │                          └─[orchestrator: escalate / exec-fail / max-rounds]──► chain escalated (workflow halted, if any)
   │                     │
   │                     └─[stale > 5min]──► stale (manual recovery needed)
   │
   ├─[decline]──► declined (chain ends)
   │
   └─[defer]──► still pending; auto-accept disarmed until manual `a`
```

**Workflow pause gate.** While the owning workflow is `paused` (`whisper workflow pause <id>`; see [Workflows](workflows.md)), the broker suspends delivery at a single chokepoint: pending handoffs are excluded from orchestration, claims and auto-accept are refused, and the mount injects nothing — so none of the transitions above advance. The one exception is **recording** an already-accepted turn's handback (`accepted → handed_back`), which is allowed so the loop can quiesce; its orchestration is deferred until `resume`. Legacy (non-workflow) handoffs are never gated.

---

## Knobs

| env var                                    | default | meaning                                                                                                          |
|--------------------------------------------|---------|------------------------------------------------------------------------------------------------------------------|
| `AI_WHISPER_IDLE_THRESHOLD_MS`             | 30000   | how long the terminal must be idle before auto-fire runs (min 5000)                                              |
| `AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED`    | (on)    | set to `0` before `whisper collab start` to disable the orchestrator. Any other value (or unset) keeps it on.    |
| `AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS` | 3       | per-collab `orchestratorMaxRounds`; bounds every legacy chain in that collab. Read once at `collab start`.       |

Workflow phases have their own `maxRounds` baked into the registry (per-phase, see table above) — `AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS` does not override them.
