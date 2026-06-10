# Concepts

This document is the mental model behind ai-whisper. The [README](../README.md) shows you how to run it; this explains how to think about it, and where the design draws hard lines. It is longer than the README on purpose, but it stays operational — every concept here maps to something you can see in `whisper collab dashboard` or `whisper collab inspect`.

## It is not a swarm

ai-whisper does not run a pool of agents that fan out, race, or vote. There are two agents — an implementer and a reviewer — and they take turns. No agent is "the orchestrator agent"; orchestration is done by the broker, not by a model improvising coordination. If you are looking for many agents working a problem in parallel, this is the wrong tool. The bet here is the opposite one: that two agents, one producing and one checking, with a clear contract between them, beat a crowd.

This is a deliberate, standing **non-goal**, not a missing feature: ai-whisper will not grow into N-agent orchestration. Role flexibility *within* the pair is fair game — which agent implements and which reviews is yours to choose, and future workflows may swap roles between phases — but the unit is always two agents passing one baton. A third agent is out of scope by design.

## Agents do not type simultaneously

At any moment exactly one agent owns the turn. The other is blocked — its input is gated until the baton comes back. This is deliberate. Two agents typing into a shared workspace at the same time produce race conditions, half-applied edits, and reviews of code that has already changed underneath them. Serializing the work removes that whole class of failure.

## Baton handoff: one owner at a time

Work moves by an explicit handoff, like passing a baton:

1. The current owner finishes a unit of work and hands back a result.
2. Ownership flips to the other agent.
3. The previous owner becomes the waiting side; its normal typing is blocked.
4. Only one unresolved handoff exists at a time.

A handoff carries the request (or the result being returned) as explicit text, so the receiving agent has the full context of what it is being asked to do or review. In a workflow the broker composes these handoffs automatically — including folding a reviewer's findings into the follow-up request when another round is needed.

Think of it as a strict baton pass, not two live sessions talking over each other. Send compact, explicit tasks so the owner can act on a handoff without reconstructing intent.

## Mounted sessions are real provider sessions — and the source of truth

When you run `whisper collab mount claude`, `whisper collab mount codex`, or `whisper collab mount ezio`, ai-whisper claims the current terminal and launches the *actual* agent in it — the real Claude or Codex CLI, or the protocol-native ezio engine. It does not simulate the agent or proxy a hidden API conversation. What you see in the terminal is the real session, and that session's state is the source of truth.

This matters for two reasons:

- **You can watch and intervene.** The work happens in a terminal you can read. Nothing important is hidden behind a daemon.
- **Capture is from the real session.** When an agent hands back, ai-whisper captures the response from the live session (clipboard / PTY). The evaluator judges what the agent actually produced, not a separate summary.

Mounted agents run in full-permission mode so the relay can drive them unattended. `mount` already passes the right autonomy flags for each provider — you do not pass them yourself.

## Autonomy is inspectable and resumable

ai-whisper automates the judgment loop — after a handback, an LLM evaluator decides whether the deliverable satisfies the request and what happens next — but the automation is supervised, not opaque:

- **Inspectable.** Every handoff, every evaluator verdict, every round number, and the running cost are visible via `whisper collab dashboard` and `whisper collab inspect`. You can always see which round a chain is on and why it advanced, looped, or escalated.
- **Resumable.** Workflow and chain state is durable (stored in SQLite under `~/.ai-whisper/`, not in the workspace). If the broker dies or you stop for the day, you `recover` and `reconnect` rather than restarting the task. Interrupted work does not silently vanish, and it does not silently resume either — recovery is explicit.

When the evaluator cannot resolve a chain (the round budget is exhausted, the agent reports it is blocked, or confidence is too low), the chain **escalates**: the automated loop stops and turn ownership returns to the original sender for a human to take over. Escalation is a designed exit, not a crash.

## Workflows are structured loops and state transitions

A workflow is not a long prompt. It is a sequence of phases, each with its own role assignment, its own pass/fail gate, and its own round budget. For example, `spec-driven-development` moves through spec-refining → plan-writing → plan-execution → code-review, each phase looping until it is approved or it escalates. `ralph-loop` is a single open-ended phase that grinds a goal chunk-by-chunk, with an independent reviewer gating each chunk until the whole goal is accepted.

Because phases and transitions are explicit state — not emergent behavior — the system knows what "done" means at each step, can enforce a round ceiling, and can resume mid-workflow. The structure is what lets autonomy run for a long time without drifting.

## Where the deep detail lives

This document is the model. The mechanics live next to the code:

- The exact handoff state machine, capture-status semantics, hotkeys, per-step verdict vocabulary, and troubleshooting: [Relay & handoff flows](relay-handoff-flows.md).
- Configuring the evaluator that gates workflows: [Evaluator configuration](evaluator-configuration.md).
- The shelved `attach` / `adopt` history: [Legacy attach mode](legacy-attach.md).
