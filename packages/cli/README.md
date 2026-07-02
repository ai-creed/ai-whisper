# ai-whisper

ai-whisper pairs two coding agents — mount any two of Claude, Codex, ezio, and agy — into a terminal-native pair that hand work back and forth under a single baton, so one agent implements while the other reviews, and a structured workflow drives the loop to a finished, reviewed deliverable without a human babysitting every round.

## Magic moment

Mount each agent in its own terminal. Each `mount` claims the current shell, launches the real provider CLI, and binds it to the collab:

```bash
# terminal 1
whisper collab mount claude
# terminal 2
whisper collab mount codex
```

Then, from inside either agent's session, kick off a structured workflow against a spec — just ask in plain language:

```text
Run spec-driven-development using docs/spec.md
```

From there ai-whisper runs the workflow autonomously:

- **Implementer / reviewer assignment** — the agent you trigger the workflow from becomes the implementer and the other agent becomes the reviewer; pass `--implementer` / `--reviewer` to choose explicitly. (Started outside a mounted session with no flags, it falls back to a default pairing and warns.) The baton passes between them; only one owns the turn at a time.
- **Autonomous execution** — the implementer does each step in its real session and hands the result back. An LLM evaluator judges whether the deliverable meets the request.
- **Review loops** — when work isn't good enough yet, the reviewer's findings are composed into a follow-up handoff and the implementer iterates. The loop repeats until the work is approved or the round budget is exhausted.
- **Resumability** — workflow and chain state is durable. If the broker restarts or you stop for the day, you recover and reconnect rather than starting over.
- **Deliverables** — you get committed code plus a review trail (per-step verdicts, round counts), inspectable at any time with `whisper collab dashboard`.

## Visual proof

A real `spec-driven-development` run: Claude (left) and Codex (middle) work in their own mounted
sessions while the dashboard (right) tracks the baton handoffs and per-phase verdicts (~20s).
Click the still to watch it play on the project page.

[![ai-whisper running a spec-driven-development workflow across two mounted agent sessions and the dashboard](docs/assets/workflow-demo-poster.png)](https://ai-creed.dev/projects/ai-whisper/)

## Who this is for

ai-whisper is for engineers who already lean on coding agents and want more structure around them:

- you already use coding agents heavily and want two of them to check each other.
- you work terminal-first and want the agents to live in real terminal sessions, not a web UI.
- you want multi-agent review — a second model gating the first model's output.
- you run long, structured workflows (spec → plan → implement → review) rather than one-off prompts.

It is **not** for:

- one-shot "vibe coding" where you just want a quick answer.
- invisible background automation you never watch.
- people new to coding agents looking for a guided, hand-holding experience.

## Prerequisites

You pair any two of four agents — `claude`, `codex`, `ezio`, and `agy`. ai-whisper drives the *real* Claude, Codex, and Antigravity CLIs, so install and authenticate whichever of those you plan to mount first; `ezio` is protocol-native and ships with ai-whisper.

- **[Claude Code CLI](https://claude.com/claude-code)** — the `claude` command, signed in.
- **[Codex CLI](https://github.com/openai/codex)** — the `codex` command, signed in.
- **ezio** *(optional)* — bundled with ai-whisper; mount it with `whisper collab mount ezio`, no separate install.
- **agy** *(optional)* — the `agy` command (Antigravity CLI), signed in. Mount it with `whisper collab mount agy` (manual-mount parity; no auto-launch via `collab start`).
- **Node.js 22+**.
- **An LLM evaluator with credentials** — workflows are gated by it and refuse to start without it. It supports four providers: **Anthropic** (default), a local **Ollama** model, **OpenAI** (and any OpenAI-compatible backend via a `baseURL` — Azure, OpenRouter, vLLM, LM Studio, …), or reusing an **already-mounted agent CLI** (`claude`/`codex`/`agy`) in non-interactive mode (no separate key — it reuses that CLI's own auth). See [Evaluator configuration](docs/evaluator-configuration.md).
- **tmux** *(optional)* — only for `whisper collab start`, which auto-arranges both agents into panes. The mount flow below does not need it.

> **Platform support:** ai-whisper is terminal-native and Unix-oriented — it drives interactive PTY sessions, so it runs on **macOS and Linux**. It is **not supported natively on Windows**: `whisper collab mount` / `reconnect` require a Unix tty-backed shell and will exit with an error pointing here. On Windows, run ai-whisper inside **[WSL2](https://learn.microsoft.com/windows/wsl/install)** — install Node, your agent CLI, and ai-whisper inside the WSL2 distro and run the commands there, where everything works as-is.

## Safety & permissions

ai-whisper launches each agent in **full-autonomy mode** so the relay can drive it unattended — `claude --dangerously-skip-permissions` and `codex --dangerously-bypass-approvals-and-sandbox`. Inside the mounted workspace the agents read, write, and run commands without prompting. Point it at code you're willing to let two agents change autonomously, watch the run on the dashboard, and remember you are the final gatekeeper — review the result before you ship it. The deeper rationale is in [Concepts](docs/concepts.md).

## Quickstart

Install from npm:

```bash
npm install -g ai-whisper
```

Or from a repo checkout:

```bash
pnpm install
pnpm build
```

Install the bundled agent skills once (they let the agents verify, kick off, and report on workflows). This also installs `ai-whisper-code-review`, the skill workflow code-review handoffs use to evaluate agent-written code, and `ai-whisper-plan-execution`, the skill plan-execution handoffs use to structure how the implementer executes an approved plan:

```bash
whisper skill install
```

Workflows require an LLM evaluator with credentials — set this up before running one. See [Evaluator configuration](docs/evaluator-configuration.md).

Then mount both agents and run a workflow:

```bash
# terminal 1
whisper collab mount claude
# terminal 2
whisper collab mount codex
```

The first `mount` creates the collab and starts the broker daemon for the workspace; the second binds the other agent. From either session, start a workflow against a spec or goal file — `spec-driven-development` for a spec, `ralph-loop` for an open-ended goal, plus `complex-bug-fixing` and `deliberation` (see [Workflows](docs/workflows.md)). Watch it run with:

```bash
whisper collab dashboard
```

- `whisper collab dashboard` — live wall of recently-active collabs + per-run inspector.
  Add `--all` to show every workflow run (no per-collab masking); combine with
  `--window all` for the full run ledger.
- From the dashboard you can pause/resume/cancel a workflow run in place
  (`p`/`r`/`c`, each confirmed), and a header bar shows live counts of running /
  paused / stuck / done / canceled / idle runs.

> Running from a repo checkout instead of a packaged install? Build first (`pnpm build`) and invoke the CLI as `node packages/cli/dist/bin/whisper.js ...` wherever these examples say `whisper ...`.

## What happens if it fails?

A run that stops short usually **escalates** — it does not crash. When the evaluator can't resolve a phase (the round budget is spent, an agent reports it's blocked, or confidence stays too low), the loop halts and turn ownership returns to you. That's a designed exit, not a failure: run state is durable, so you read the dashboard, fix the spec or unblock the agent, and `whisper workflow resume <id>` to pick up where it left off. Escalation is the system asking for a human exactly when it should — seeing it is normal, not a sign something broke.

## Core concepts

ai-whisper is **not a swarm**. The agents never type at once — work moves by a single baton, one owner at a time. Mounted sessions are *real* agent sessions in your terminal — Claude or Codex CLIs, ezio, or agy — and those sessions are the source of truth. Autonomy is supervised: every handoff, verdict, and round is inspectable, and runs are resumable rather than fire-and-forget. Work is organized as structured workflows — explicit loops and state transitions, not a free-form chat.

Claude, Codex, ezio, and agy are supported today — you mount any two of them; the architecture is provider-agnostic by design, so other coding-agent CLIs can be added behind the same relay.

For the full mental model, read [Concepts](docs/concepts.md).

## Duo characters

Every collab casts its two agents as a classic movie duo. The first `whisper collab mount` rolls a pair — Sherlock & Watson, Batman & Robin, Walter White & Jesse Pinkman, and four more — and each mount summons its character with ASCII art and an iconic one-liner before the agent CLI starts. The assignment sticks for the lifetime of the collab: the dashboard and relay chrome show `Batman (claude)` instead of a bare vendor name, and the agents themselves are told who they are (character flavor stays in conversational prose only — never in code, commits, or workflow verdicts).

It's cosmetic and entirely optional. Turn it off per mount with `--no-duo`, or permanently with `AI_WHISPER_DUO=off` in your environment; an opted-out mount rolls nothing, shows nothing, and falls back to plain vendor names everywhere.

## Learn more

- [Workflows](docs/workflows.md) — how to use the four workflows well: choosing between `spec-driven-development`, `ralph-loop`, `complex-bug-fixing`, and `deliberation`, and authoring the spec, goal, bug report, or seed that drives the run.
- [Concepts](docs/concepts.md) — the mental model: baton handoff, real mounted sessions, supervised autonomy, workflow-first execution.
- [Relay & handoff flows](docs/relay-handoff-flows.md) — the complete handoff state machine, capture-status table, hotkey reference, per-step verdicts, and troubleshooting.
- [Evaluator configuration](docs/evaluator-configuration.md) — required credentials and options for the LLM evaluator that gates workflows.
- [Legacy attach mode](docs/legacy-attach.md) — the shelved `attach` / `adopt` flows, kept for historical reference.

## Workspace commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions are
accepted under the [Developer Certificate of Origin](CONTRIBUTING.md) (sign off with
`git commit -s`).
