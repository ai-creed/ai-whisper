# ai-whisper — Quick FAQ

## 🟢 The What

**What is ai-whisper, in one breath?**
It pairs two coding agents — any two of Claude, Codex, and ezio — into a terminal-native duo that passes work back and forth. One agent *implements*, the other *reviews*, and a structured workflow drives the loop all the way to a finished, reviewed result — without you babysitting every round.

**So… it's a swarm of AI agents?**
Nope, and that's on purpose. It's exactly **two** agents taking turns — never a crowd racing or voting. The bet is simple: one agent producing and one agent checking, with a clear contract between them, beats N agents improvising. "Not a swarm" is a deliberate design line, not a missing feature.

**Which agents can I pair?**
Any two of **Claude**, **Codex**, and **ezio**. Claude and Codex run their *real* CLIs (you sign in once); ezio ships with ai-whisper, so it needs no separate install. The design is provider-agnostic, so more agents can slot in later.

**What do I actually get at the end?**
Committed code **plus a review trail** — per-step verdicts, round counts, the whole handoff history — all inspectable any time on the dashboard.

## 🔵 The Why

**Why two agents instead of just one really good one?**
Because a second model gating the first catches what the first misses. You get multi-agent review built in: the implementer can't merge its own homework — the reviewer has to sign off first.

**Why live in the terminal instead of a slick web UI?**
The mounted sessions are the *real* agent sessions, right there in your terminal — not a simulation or a hidden API conversation. That means you can **watch and intervene** at any moment, and what the reviewer judges is what the agent *actually* produced. Nothing important hides behind a daemon.

**Why should I trust it to run autonomously?**
Because autonomy here is **supervised, not opaque**. Every handoff, every verdict, every round, and the running cost are visible live. And it's **resumable** — state is durable, so if you stop for the day (or the broker restarts), you reconnect and pick up where it left off instead of starting over.

**Who's this really for?**
Engineers who already lean on coding agents and want more structure: you want two models checking each other, you live terminal-first, and you run long structured workflows (spec → plan → implement → review) rather than one-off prompts. It's *not* for quick one-shot "vibe coding" or fully-invisible background automation.

## 🟣 The How

**How do I kick off a run?** *(this is the demo money-shot)*
Mount each agent in its own terminal:
```bash
# terminal 1
whisper collab mount claude
# terminal 2
whisper collab mount codex
```
Then, from inside either session, just **ask in plain language**:
```text
Run spec-driven-development using docs/spec.md
```
From there it runs autonomously.

**What's this "baton" thing?**
Think of a relay race. Exactly one agent owns the turn at a time; the other is paused. When the owner finishes a chunk, it hands the baton (and the full context) back, and ownership flips. Only one handoff is ever in flight — so no two agents typing over each other, no half-applied edits.

**Who implements and who reviews?**
Whichever agent you trigger the workflow from becomes the **implementer**; the other becomes the **reviewer**. You can also pick explicitly with `--implementer` / `--reviewer`.

**What workflows ship with it?**
Four, each suited to a different starting point:
- **spec-driven-development** — you have a spec (spec → plan → implement → review).
- **ralph-loop** — an open-ended goal it grinds chunk-by-chunk.
- **complex-bug-fixing** — a bug report to chase down.
- **deliberation** — a fuzzy idea to pressure-test.

**How does the review loop actually work?**
When work isn't good enough yet, the reviewer's findings get folded into a follow-up request, the implementer iterates, and it repeats — until the work is **approved** or the round budget runs out. An LLM evaluator is the judge of "is this good enough?"

**What happens when it gets stuck?**
It **escalates** — it doesn't crash. If the round budget's spent, an agent says it's blocked, or confidence stays too low, the loop halts and hands the turn back to *you*. That's a designed exit: read the dashboard, fix the spec or unblock it, then `whisper workflow resume <id>`. Seeing escalation is normal — it's the system asking for a human at exactly the right moment.

**How do I watch it all happen?**
```bash
whisper collab dashboard
```
Live baton handoffs, per-phase verdicts, round counts, and cost.

## 🔬 Under the hood (for the deep-dive questions)

*Pull this out when someone asks "okay, but how does it* actually *work?" It's deeper than the rest on purpose — still conceptual, no code walk-through needed.*

**What are the moving parts?**
Four, roughly:
- **The broker** — a background daemon, one per workspace, started automatically by your first `mount`. It *is* the orchestrator: it owns the handoff state machine, calls the evaluator, and drives the chain forward. Important nuance: no *agent* is "the orchestrator" — a real process is. Coordination isn't left to a model improvising.
- **Mounted panes** — each `mount` claims a terminal and launches the *real* provider CLI inside a PTY (pseudo-terminal). That pane process babysits the session: it injects requests, watches for the reply, and captures the handback.
- **Adapters** — per-provider glue (`claude`, `codex`, `ezio`) so the same relay logic can drive each CLI's quirks.
- **A shared SQLite store** at `~/.ai-whisper/state.db` — the durable brain. Every workflow, chain, and handoff lives here, *outside* your repo.

**Walk me through a single handoff, end to end.**
1. A handoff is created as a row: `status=pending`, carrying the `request_text`.
2. The target pane picks it up and **accepts** — types the request into the PTY and hits Enter → `status=accepted`.
3. The real agent does its thing in its own live session.
4. When the turn completes, the pane **captures** the reply and hands it back → `status=handed_back`, with the captured text plus a capture-quality label.
5. The **broker's orchestrator** reads the handback, asks the evaluator for a verdict, and either resolves the chain, fires a follow-up handoff (round++), or escalates.

There's only ever **one** unresolved handoff at a time — that's the single baton, enforced in state, not by politeness.

**How does it know what the agent actually said? (the clever bit)**
This is the hardest part, because the reply lives in a live terminal, not a clean API response. Two paths:
- **Turn events (the default today)** — Claude and Codex emit a turn-completion signal the pane listens for, so capture fires the moment the turn genuinely ends.
- **Idle + scrape (the classic fallback)** — after the terminal sits idle (~30s) and a visible reply was seen, the pane reads the agent's `/copy`'d clipboard *and* scrapes the PTY, then **classifies** the result: a healthy clipboard grab is `ok`; a weak or empty one gets flagged so the orchestrator re-issues instead of judging garbage. (For short replies it even cross-checks clipboard vs. on-screen text with a similarity threshold before trusting it.)

That capture-quality label is the unsung hero — it's why a missed `/copy` triggers a retry rather than silently corrupting a verdict.

**What exactly is the evaluator deciding?**
After each handback it returns one verdict from a fixed vocabulary that depends on *which step* we're in:
- a **review** step → `approve` / `findings` / `escalate`
- an **implement** or **fix** step → `delivered` / `escalate`
- an **execute** step → `execution-pass` / `execution-fail` / `escalate`

`approve` advances the phase; `findings` loops back to a fix (round++); `escalate` halts and hands you the turn. Each workflow swaps the *prompt* behind these verdicts — not the machinery. (Deliberation, for instance, runs a stricter prompt that rejects a rubber-stamp "looks good" as `findings`.)

**What stops it looping forever?**
A hard **round budget**. Every phase carries a `maxRounds` (e.g. 5 for review phases, 1 for execution). The orchestrator checks that ceiling *before* it even calls the LLM — so a chain that can't make progress (even one where capture keeps failing) escalates instead of spinning. Escalation returns the turn to a human; that's the designed exit.

**What's durable if something crashes?**
Everything that matters. Workflow, chain, and handoff state all live in SQLite outside the workspace, and each handoff row is updated in place as it moves `pending → accepted → handed_back → evaluated`. A broker restart or an overnight stop means you `recover` / `reconnect` and `whisper workflow resume <id>` — never start over.

**The whole loop as one picture:**
```
  pending ──accept──► accepted ──hand back──► handed_back
                                                  │
                              evaluator verdict ──┤
                                                  ├─ approve / delivered / exec-pass ─► advance phase (or resolve)
                                                  ├─ findings ────────────────────────► new pending handoff (round++)
                                                  └─ escalate / exec-fail / max-rounds ► halt ─► turn returns to you
```

## ⚙️ Quick practical bits

**What do I need?** Node.js 22+, the CLIs for whichever agents you mount (signed in), and **an LLM evaluator with credentials** — workflows refuse to start without it. tmux is optional (only for the auto-pane layout).

**Is it safe?** Agents run in full-autonomy mode so the relay can drive them unattended — they read, write, and run commands without prompting. So point it at code you're willing to let two agents change, watch the dashboard, and remember **you're the final gatekeeper** — review before you ship.

**Windows?** Not natively (it's Unix/PTY-based) — run it inside **WSL2**, where everything works as-is. macOS and Linux are first-class.

## 🎯 Tricky-questions cheat-sheet

*The skeptical questions a demo audience actually asks — with a one-liner you can fire back. Answers are honest, not hype.*

**"Isn't this just CrewAI / AutoGen / LangGraph?"**
Those orchestrate agents *over an API, in one process*. ai-whisper drives the **real vendor CLIs in real terminals**, cross-vendor (Claude ↔ Codex), with an independent LLM gating each phase. The "two different vendors' CLIs checking each other, under a phase-gate" combo isn't something those frameworks do.

**"Why not just use one bigger, better model?"**
Because a model grading its own homework is the weak spot. An **independent** second model catches what the first is blind to — and it's the *separation* of producer and checker that adds the value, not raw horsepower.

**"Isn't a swarm of N agents better? Why only two?"**
Deliberate design line, not a limitation. Two agents with a clear contract beat a crowd improvising — no races, no voting, clear accountability for who did what. It will *not* grow into N-agent orchestration; role flexibility within the pair is the only knob.

**"What if the two agents disagree, or the reviewer is just wrong?"**
The reviewer only says approve / here-are-findings — it doesn't get to declare the workflow done. A **separate evaluator** owns that call, the round budget bounds the back-and-forth, and if they can't converge it **escalates to you**. You're the tiebreaker.

**"Is the reviewer just rubber-stamping everything?"**
The evaluator uses step-specific verdicts and stricter prompts where it matters — deliberation, for example, explicitly downgrades a hollow "looks good" with no real reasoning to *findings*, not *approve*. A layer can't pass on a rubber-stamp.

**"How's this different from me copy-pasting between two agent tabs?"**
That's literally the manual version — and it's exactly what gets automated: the baton handoff, capturing each reply, the evaluator verdict, the looping, *and* a durable, inspectable trail of every round. Plus structured workflows with real gates instead of vibes.

**"Running everything in `--dangerously-skip-permissions` — isn't that reckless?"**
It's **scoped and supervised**, not fire-and-forget. Point it at code you're willing to let two agents change, watch it live on the dashboard, and you review before anything ships. Autonomy with a human gatekeeper, not a blank cheque.

**"Two agents = double the token cost, right?"**
Honestly, yes — it spends more than a single one-shot, by design. The bet is that for *long, structured* work, a second model catching a bad change is cheaper than shipping it. And cost is shown live on the dashboard, so it's never a surprise. (For one-off questions, this is the wrong tool — and we say so.)
We deliberately trade cost for autonomy + quality (hopefully but proven).

**"Why terminals instead of a clean API integration?"**
Because the real CLI session *is* the source of truth — you can watch and intervene, and the evaluator judges what the agent actually produced, not a hidden summary. Bonus: it reuses your existing CLI auth and tooling, nothing to re-plumb.

**"Can I leave it running overnight?"**
Yes — supervised. State is durable and resumable, and it escalates the moment it's genuinely stuck rather than burning rounds. You come back to a dashboard trail, not a mystery.

**"Am I locked into Claude + Codex?"**
No — it's provider-agnostic by design. Any two of Claude / Codex / ezio today; more CLIs can slot in behind the same relay later.

