# Workflows

A workflow is a structured loop: a sequence of phases, each with its own role assignment, its own pass/fail gate, and its own round budget. It is not a long prompt — the structure is what lets autonomy run for a long time without drifting. For the model behind that, read [Concepts](concepts.md); this document is about getting good results from it.

The outcome of a run is mostly decided by two choices you make before anything starts: which workflow you pick, and what you feed it. Everything else — mounting, kickoff, watching the dashboard — is mechanics. This guide spends most of its words on those two choices.

ai-whisper ships four workflows today. All run an implementer and a reviewer that take turns — the agent you trigger the run from becomes the implementer and the other becomes the reviewer (override with `--implementer` / `--reviewer`) — and all are gated by the LLM evaluator that decides, after each handback, whether to advance, loop, or escalate.

## The four workflows at a glance

**`spec-driven-development`** is a phased pipeline. It moves through spec-refining → plan-writing → plan-execution → code-review. Each phase has its own gate and loops until it is approved or it escalates, then the next phase begins. You give it a spec; it sharpens that spec into a plan and executes the plan under review. Use it when you can describe the deliverable up front.

**`ralph-loop`** is a single open-ended phase. It reads a goal file as ground truth and grinds toward it chunk-by-chunk: each iteration the implementer picks the next smallest independently-verifiable chunk, delivers it, and a reviewer checks that chunk. When the implementer claims the whole goal is done, an acceptance review gates completion against the goal's criteria. Use it when the work is long-horizon or hard to fully plan in advance.

**`complex-bug-fixing`** is a fixed three-phase pipeline for a reported bug whose root cause is unknown: diagnosis → fix-and-verify → post-mortem. The implementer must **reproduce the bug themselves** (a committed failing test is strongly preferred — speculation from reading code is not a valid reproduction) and write a diagnosis (root cause + proposed fix + blast radius + residual risks); an adversarial reviewer independently reproduces it and keeps the gate shut until both agree the cause is proven and the fix is net-safe. The fix phase turns the reproduction GREEN and verifies across the blast radius under an acceptance review that also checks test-coverage adequacy; the post-mortem records what happened. The diagnosis and post-mortem are self-verification artifacts for you after the run — they live in the gitignored run dir `.ai-whisper/bugfix/<workflowId>/` and are **not** committed; only the fix and the reproduction test land in the repo. Use it when a bug is reported and a correct, verified, non-regressing fix matters.

**`deliberation`** is an open-ended dialectic. It pairs an Explorer and a Challenger that move through four phases — Objectives, Approaches, Tradeoffs, and Synthesis — cycling independently through each phase until both agree on the space and the Synthesizer can commit a findings doc. The output is a structured handover into brainstorming or SDD; it never auto-chains. Use it when you have a fuzzy idea, cannot yet describe "done," and want the space mapped before you commit to a spec.

Ralph keeps durable memory under `.ai-whisper/ralph/<workflowId>/`: `PROGRESS.md` (the work ledger) and `LEARNINGS.md` (generalizable lessons). On every iteration the implementer re-orients from the goal file plus these two files rather than from prior conversation, so progress survives context compaction over a long run. The implementer is instructed to commit each chunk's code changes as it delivers them; the reviewer's approval gates whether the loop advances to the next chunk, not whether the commit is made — so a chunk that draws findings may already be in history, followed by fix commits.

## Choosing the workflow

The question to ask is: **can you describe "done" before you start?**

Reach for **spec-driven-development** when:

- the deliverable is specifiable up front — a feature, an endpoint, a refactor with a clear target shape;
- the work benefits from an explicit plan that a reviewer can approve before code is written;
- it fits in roughly one plan's worth of work. If it sprawls across many independent subsystems, decompose it first and run SDD on each piece.

Reach for **ralph-loop** when:

- the goal is open-ended or long-horizon — a checklist to burn down, a standard to bring a codebase up to, "keep going until all of this is true";
- you cannot realistically plan every step in advance, but you can state what the finished state looks like;
- the work is naturally a series of small, independently-verifiable chunks rather than one atomic deliverable.

Reach for **complex-bug-fixing** when:

- a bug was reported, the **root cause is unknown**, and you cannot yet describe the fix — the whole point is to investigate it;
- a confidently-wrong fix would be expensive, so you want the cause **proven by an observed reproduction** and an adversarial reviewer guarding against symptom-patching before any code changes;
- a correct, verified, non-regressing fix matters more than speed. (For a bug whose fix you can already specify, use SDD instead — you do not need the diagnosis gate.)

Reach for **deliberation** when:

- you have only a fuzzy idea and cannot yet describe "done" — you want the space mapped (objectives, approaches, tradeoffs) before you commit to a spec;
- you want the legwork and the adversarial thinking done autonomously while you are unavailable, and handed back as a findings doc you can review and then take into brainstorming or SDD;
- the topic is usually grounded in a concrete project, though a no-anchor topic still runs (it degrades to web-grounded research). Its output feeds the other workflows — it never auto-chains there.

**Signs you picked wrong:**

- You wrote an SDD spec that is really an open-ended checklist of unrelated items. The plan phase will struggle to produce one coherent plan. Use ralph.
- You wrote a ralph goal that is actually a single well-defined deliverable. You are paying for chunk-by-chunk overhead and per-chunk reviews on something that wanted one plan and one review. Use SDD.
- The run escalates immediately and repeatedly. That is usually an artifact problem, not a workflow problem — see the next section.

## Authoring the artifact

This is the biggest lever you have. A precise artifact is the difference between a run that converges and one that loops until the round budget is exhausted.

### Writing a spec for spec-driven-development

The spec is a **starting point, not a contract**. SDD's first phase refines it, so you do not need to get every detail right — you need to get the *intent* and the *acceptance criteria* right.

A good spec:

- states the deliverable concretely — what exists when this is done, in terms a reviewer can check;
- spells out acceptance criteria explicitly, so the code-review phase has a target to gate against;
- names hard constraints (interfaces to honor, patterns to follow, things that must not change);
- stays scoped to one plan's worth of work.

Avoid: a wishlist of loosely related features, "make it better" without a definition of better, or implementation detail so prescriptive that the plan phase has nothing to add.

> **Weak:** "Improve the auth module. It's messy and slow."
>
> **Strong:** "Replace the per-request token decode in `auth/verify.ts` with a cached verifier. Done when: tokens are verified against a key set cached for its TTL, a cache miss refetches once, expired/invalid tokens still 401, and the existing auth tests pass unchanged. Do not change the public `verifyRequest` signature."

This is not hypothetical. ai-whisper itself was built this way — nearly every feature in this repo started as a spec run through `spec-driven-development`, and those specs are still in the tree under [`docs/superpowers/specs/`](superpowers/specs/). If you want to see what a spec that actually drove a run looks like — scope, acceptance criteria, the level of detail that converges rather than loops — read a few of them. They are battle-tested by the fact that the code they describe exists.

### Writing a goal for ralph-loop

The goal file is read as ground truth and **re-read on every iteration**. That single fact drives how you write it: anything you want applied to every chunk must live *inside the goal*, because the implementer re-orients from the goal each iteration rather than from prior conversation, so the goal is the thing that reliably persists across a long run.

A good goal:

- frames the finished state as a checklist of independently-verifiable items, so the loop can pick the next smallest chunk and a reviewer can check it in isolation;
- **embeds the per-chunk procedure** — test-first, lint, commit format, and especially the definition-of-done — directly in the file. There is no separate procedure artifact; the goal carries it;
- defines what "the whole goal is complete" means, so the final acceptance review has a target rather than a vibe.

Avoid: a goal that is really one atomic task (use SDD), procedure kept in your head or in chat (the implementer re-orients from the files, not the conversation, so it will not carry over), or a finish line you never wrote down (the acceptance review cannot pass what it cannot check).

> **Weak:** "Add tests to the project."
>
> **Strong:** "Bring every module under `packages/broker/src/storage/` to ≥90% line coverage.
> For each chunk: pick one untested file, write tests first, then run `pnpm test` and `pnpm lint` — both must pass before you hand back. Commit each file's tests separately as `test(storage): cover <file>`.
> The whole goal is done when `pnpm test --coverage` reports ≥90% for every file in that directory and no test is skipped."

### Writing a bug report for complex-bug-fixing

The bug report is read as the starting point for an investigation, so write it for **reproduction**, not diagnosis. The single biggest lever is how easily the implementer (and then the reviewer, independently) can make the bug happen — the faster they reproduce it, the faster the diagnosis gate converges.

A good bug report:

- describes the **symptom** concretely — what goes wrong, where, and how you know (the error, the wrong output, the crash);
- gives **reproduction steps** precise enough to follow blindly — exact inputs, commands, environment, and the smallest sequence that triggers it;
- states **expected vs actual** behavior explicitly, so "fixed" has a checkable meaning.

Do **not** include your own root-cause theory as if it were settled. The workflow exists to *prove* the cause from an observed reproduction; a confident wrong guess in the report can anchor the run on the wrong premise. If you have a hunch, mark it clearly as a hunch.

> **Weak:** "Login is broken sometimes, probably a token caching bug."
>
> **Strong:** "After ~15 minutes idle, the first request to `/api/me` returns 401 even with a valid session. Repro: log in, wait 15 min, refresh the dashboard → 401 toast; server logs show `token expired` though the session cookie is still present. Expected: the request succeeds (or transparently refreshes). Actual: 401 until a full re-login. (Hunch, unverified: the access token TTL may be shorter than the session TTL.)"

### Writing a seed for deliberation

A seed is a one-to-three sentence statement of the topic you want to deliberate — the fuzzy idea, the problem area, or the question you are trying to map. The seed is the starting point for an open-ended dialectic, so write it for **exploration**, not solution.

A good seed:

- names the topic concretely — what domain or problem are we mapping;
- is open-ended enough to leave room for objectives, approaches, and tradeoffs to emerge — do not prescribe the solution;
- optionally includes an intent-anchor (a concrete grounding like a project or a goal) and/or a non-goal (what we are *not* trying to do), to shape the dialectic without closing it.

Avoid: a seed that is really a spec (you already know the solution), a seed so vague it could mean anything (the Explorer and Challenger will struggle to converge), or a seed that is purely off-the-shelf research with no project grounding (use web search instead).

> **Weak:** "How should we do auth?"
>
> **Strong:** "How should we redesign auth for the dashboard given the new mobile OAuth flow? We're not replacing the session layer, just the initial login path."

## Running a workflow

The mechanics are deliberately thin. From a workspace, mount both agents in separate terminals, then start a workflow from either session:

```bash
# terminal 1
whisper collab mount codex
# terminal 2
whisper collab mount claude

# from either session
whisper workflow start --type=spec-driven-development --spec=/abs/path/to/spec.md
whisper workflow start --type=ralph-loop --spec=/abs/path/to/goal.md
whisper workflow start --type=complex-bug-fixing --spec=/abs/path/to/bug-report.md
whisper workflow start --type=deliberation --spec=/abs/path/to/seed.md
```

The `/aiw-sdd <path>`, `/aiw-ralph <path>`, `/aiw-bugfix <path>`, and `/aiw-deliberation <path>` skills do the same thing with a readiness check first — they require the bundled skills to be installed once (`whisper skill install`; see the README quickstart). Roles follow the caller: the agent you start the run from is the implementer and the other agent reviews, so you do not normally pass `--implementer` / `--reviewer` — add them only to override. (Started outside a mounted session with no flags, the run falls back to the workflow type's default pairing and warns.)

Then watch it run:

```bash
whisper collab dashboard
```

The dashboard is the inspection surface — every handoff, every evaluator verdict, the round number, and the running cost are visible there. **Do not babysit a run from a chat session.** The broker uses idle detection to know when an agent is ready for the next handoff; an agent that keeps emitting output never reads as idle, and the handoff stalls. Kick off, then observe from the dashboard.

Runs are durable, not fire-and-forget — but how you pick a run back up depends on *what* interrupted it:

- **A halted workflow** (it escalated, or you halted it) resumes directly: `whisper workflow resume <workflowId>`.
- **An interrupted broker or session** (the daemon died, you stopped for the day, a mounted session dropped) is a recovery case, not a resume case: `whisper collab recover`, then `whisper collab reconnect <codex|claude>` for each agent, then check `whisper collab status` / the dashboard. The workflow continues from its durable state once the collab is healthy again.

To stop a run for good: `whisper workflow cancel <workflowId>` (canceled workflows cannot be resumed).

### Pausing a healthy run to fix an artifact

Sometimes a run is healthy but heading the wrong way — a glitch in the spec, plan, or source has steered both agents, and you want to step in *without* the escalation semantics of `halt`. Pause it:

```bash
whisper workflow pause <workflowId>
```

Pause freezes the whole loop at the next safe boundary: the in-flight turn is never killed — it finishes and its handback is recorded — but no new turn is delivered while paused. The workflow keeps the collab's active slot, so you cannot accidentally start a second run on top of it. Edit the artifact while the daemon keeps running in the background, then continue:

```bash
whisper workflow resume <workflowId> --message "what I changed and why"
```

On resume the agents receive a one-time notice listing the files you changed while paused (diffed against a snapshot taken at the moment the run quiesced, so your edits are never confused with the agent's own) plus your `--message`, and are told to re-read those files before continuing — so they re-evaluate instead of pressing ahead on stale context. `--message` is optional; with no operator edits and no message, resume just continues the run.

`resume` acts on both **paused** and **halted** workflows (and rejects anything else); `pause` acts only on a **running** workflow. You can also ask a mounted agent to pause for you mid-task ("pause the workflow, I need to fix X") — it knows to look up the id, run `whisper workflow pause`, and stop. (Trigger is CLI-only; on the Codex CLI, note that Ctrl+C at an idle prompt exits the session, so interrupt a *busy* agent before asking.)

When the evaluator cannot resolve a chain — the round budget is exhausted, the agent reports it is blocked, or confidence is too low — the chain **escalates**: the loop stops and ownership returns to you. Escalation is a designed exit, not a crash. For round budgets, verdict vocabulary, and the full state machine, see [Relay & handoff flows](relay-handoff-flows.md); for the evaluator credentials and model, see [Evaluator configuration](evaluator-configuration.md).

## You are the final gatekeeper

Autonomous means the *loop* runs without you — implement, review, iterate, converge — not that the result ships on its own. The evaluator gates each handoff and the reviewer agent checks every phase, but that raises the floor; it does not certify that the work clears your bar. The reviewer is a second model, not your QA sign-off, and the acceptance criteria the run converges on are the ones *you* wrote — a run can satisfy a thin or wrong spec perfectly.

So treat a finished workflow as a strong draft, not a shipped deliverable. Before anything merges, deploys, or releases, a human developer still reviews, verifies, and QAs the final output — reads the diff, runs the thing, judges whether it actually solves the problem. ai-whisper does the convergence work and shows you the full trail to make that judgment fast; the decision to ship stays yours. This is the same line concepts.md draws as *supervised autonomy*: escalation hands control back to you mid-run, and so does the end of every run.

## Getting better outcomes

- Pick the workflow by whether you can describe "done" up front: yes → SDD, not yet → ralph.
- Write acceptance criteria a reviewer can actually check. A run can only converge on a target it can see.
- For ralph, embed the per-chunk procedure and the definition-of-done *in the goal file* — the implementer re-orients from it each iteration, so it is the one place instructions reliably persist.
- Keep chunks small and independently verifiable. Big chunks produce big reviews and slow loops.
- Let it run. Observe from the dashboard, not from chat.
- Treat escalation as information. A run that escalates fast almost always means the artifact, not the workflow, needs another pass.
- A finished run is a draft, not a release. Review, run, and QA the deliverable yourself before you ship it — you are the final gatekeeper.
