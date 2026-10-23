# Notice-Path Handoff Delivery — Design

**Date:** 2026-10-23
**Status:** Approved for planning (2026-10-23).
**Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-whisper/specs/2026-10-23-notice-path-handoff-design.md`
**Repo mirror:** `docs/superpowers/specs/2026-10-23-notice-path-handoff-design.md`

## Problem

Workflows are unstable because of how we get handoffs into a mounted agent's terminal and how we get the agent's answer back out. Today the mount **types the whole handoff request into the provider's PTY**. It then works out the handback by watching turn-end hooks and the terminal going quiet, pressing `/copy`, and reading the clipboard.

Evidence from three SDD runs in `~/Dev/blackroom` (`wf_b07db61c948045a2`, `wf_7eb73f3f110741cb`, `wf_69c35257d9924f3d`) shows two separate defects.

### Defect 1: injected prompts lose their beginning (claude)

- On macOS, node-pty delivers a large `pty.write` to the reader in **1022-byte reads**. A 1332-byte request arrived as `[1022, 310, \r]`.
- The claude submit strategy (`packages/cli/src/runtime/provider-submit-strategy.ts:29-34`) writes the whole prompt in one raw write, with no bracketed paste. It then waits 75 ms and sends `\r`.
- Claude Code usually stitches those reads into a single `<pasted_content>` message. In **17 of 36** claude injections it kept only the last read. The transcript's user message was the request minus exactly *k*×1022 leading bytes.
  - Example: `ho_c7a562cf23b54839` delivered only the 310-byte operator-control tail. Claude answered "Nothing to act on there", and the workflow escalated.
- Orca (stablyai/orca) documents the same failure in `src/main/runtime/terminal/input/terminal-agent-prompt.ts:118`: Claude's composer "can drop the beginning when a large frame is split into independently processed chunks."
- Codex was not affected in these runs.

### Defect 2: a "Waiting for …" turn is captured as the handback

Seen in `ho_3166f6e8ecba4ffd` and `ho_1061ebe8bde140cd`. Claude ran background subagents, and each turn that only waited for them still fired the Stop hook. The sequence:

1. The transcript's latest user message is a `<task-notification>`.
2. Input correlation fails, so the turn is logged `ignored_unrelated_turn`.
3. After 30 s of quiet plus grace, the `/copy` fallback captures the interim "Waiting for its notification…" text as the handback.
4. The evaluator escalates.

Verified separately: claude's Stop payload carries `background_tasks`, and it is non-empty in exactly this situation.

Both defects come from the same design. The terminal is used as a transport for large payloads, and the handback is *inferred* rather than *declared*.

## Intent

Make handoff delivery reliable without depending on any provider's terminal paste handling, hook layout or screen output:

- **Delivery:** the broker stores the full request. The mount types a one-line notice. The agent fetches the request with a CLI command.
- **Handback:** the agent declares it explicitly with a CLI command.

Everything that exists today stays in place as a fallback. Fallback is removed later, once data shows the notice path holds up.

## Goals

1. No workflow prompt is ever pasted into a provider terminal on the primary path. The kickoff, every phase request, fix rounds and resume continuations are all one typed line.
2. Every handback on the primary path is what the agent submitted through `whisper handoff reply`. There is no clipboard, screen scrape or relevance guessing.
3. An interim turn ("Waiting for …", background subagents) can never complete a handoff.
4. A generalized, provider-agnostic "turn finished" signal that every mounted provider can send.
5. Each handoff records which delivery path and which capture path it actually used, so the eventual fallback removal is driven by data.

## Non-goals

- Removing the paste or `/copy` paths in this change. They become the fallback.
- Changing provider hooks. The claude Stop hook, codex `notify` and agy hooks stay exactly as they are.
- Sandbox or permission handling. In mount mode every provider already runs fully autonomous (`packages/cli/src/runtime/providers.ts:41-95`: codex `--dangerously-bypass-approvals-and-sandbox`, claude/agy `--dangerously-skip-permissions`, cursor `--force`).
- Fixing the paste path itself, for example adding bracketed paste for claude. The fallback keeps today's behavior byte for byte.
- Capturing operator-typed prompts. This is a known gap, tracked separately.
- Duo persona brief and `@@pull` context injection. These are not workflow prompts. Moving them to notices is follow-up work.
- **Manual (non-workflow) handoffs**, including the `a` / `e` / `d` / space owner keys and `amendPendingHandoff`. These only act on non-autonomous handoffs today (`mounted-turn-owned-relay.ts:779-783` returns early for autonomous ones). They stay exactly as today: paste plus today's capture. Amend is therefore not a workflow prompt and is out of scope.

## Anti-goals

These would make the change a failure even if it technically works:

- **Breaking any currently supported provider** (claude, codex, ezio, agy, cursor). Every provider must work at least as well as today on the day this ships.
- **A silent fallback.** If paste or `/copy` gets used, the operator must see it in the pane and in the data.
- **Delivering the same work twice.** In particular: pasting after the agent has already fetched, or typing the notice twice for one handoff.
- **Agents reaching into `~/.ai-whisper/state.db` directly.** In the spike, codex did this when `show` failed. Every error message must tell the agent what to do instead.
- **Moving prompt fragments into skills as their only channel.** This would break the existing decision that the handoff prompt fragment is the primary mid-workflow channel and skills exist for discoverability.

## Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Primary delivery | **Notice path** for every workflow prompt, kickoff included. Paste is the fallback. |
| D2 | Primary handback | **`whisper handoff reply <id> --file <path>`** is the only way to complete a handoff on the primary path. `/copy` capture is the fallback. |
| D3 | What `show` returns | The **stored `relay_handoff.request_text`, verbatim**, composed once at creation time, as today. It is never re-rendered at fetch time. |
| D4 | Prompt fragments | Operator control, the plan-execution hint, resume notice and handback contract stay **inside the stored request**, composed by the broker as today. They are not moved into skills. The kickoff-skill sections remain for discoverability only. |
| D5 | Notice framing | The notice says the fetched request **is the operator's instruction for this turn**. This gives fetched content user-turn authority. Spike: claude 2/2 and codex 4/4 followed it, and the bare notice also worked. The framed wording is kept on purpose. |
| D6 | CLI binary | The notice names plain `whisper`. **`show`, `reply` and `turn done` refuse on a CLI↔broker version mismatch** with a fixed instruction. Absolute binary paths were rejected because they make the notice long and hard to read. |
| D7 | Idle detection | **Keep the existing 30 s quiet-terminal gate** as the guarantee. A new **`whisper turn done`** command is added as an extra signal. Provider hooks stay but are not required. |
| D8 | Fallback trigger | **Automatic per handoff**, through the ladder in §5, plus a **static per-provider capability** for providers that cannot run commands. It is never a manual switch, because workflows run unattended. |
| D9 | Fallback visibility | Every fallback prints a ⚠ `[ai-whisper]` line in the mount pane and is recorded on the handoff. |
| D10 | Strict mode | An env switch disables all fallbacks, so test runs prove the notice path on its own. |
| D12 | No explicit signal | A fetched handoff with no `reply` and no `turn done` past the idle cap plus one nudge **escalates for human review**. It is never `/copy`-captured. |
| D11 | Removal of fallback | A later release, decided by the operator from the recorded path data. There is no fixed threshold. |

Rejected alternatives:

- **Bracketed paste for claude**, which fixes Defect 1 only and still relies on TUI paste behavior.
- **Agents querying SQLite directly.** This couples agents to the schema, adds lock contention and gives no fetch record.
- **Hook-based idle as the primary signal.** Every provider configures hooks differently (ezio, cursor and agy have no common shape).
- **A manual fallback switch.** It halts unattended runs.

## Design

### 1. Provider coverage

| Provider | Path | Why |
|---|---|---|
| claude, codex, agy, cursor | Notice path, with fallback | In mount mode these run as full-autonomy agent CLIs that can execute `whisper`. |
| ezio | **Unchanged** (protocol-native submit and handback) | ezio runs in-process over the ai-ezio protocol. It has no PTY paste and no `/copy` capture, so neither defect applies. *(My call; see "Calls made".)* |

This is a static capability on the mount target, for example `deliveryMode: "notice" | "native"`. It is not a runtime guess.

The path is chosen **per handoff**:

- **Notice path:** the handoff is workflow-owned (`workflow_id` set, autonomous) **and** the target mount's `deliveryMode` is `notice`.
- **Today's path:** every other handoff (manual, non-workflow) on any provider, unchanged.

### 2. The notice

The mount types the notice once the agent is idle (§4). It is one line, printable ASCII only, with no embedded newlines, written as a single write. A separate `\r` follows after the existing per-provider delay. It must stay well below 1022 bytes. Builder target: ≤ 400 bytes, with a guard test that enforces the limit.

Wording, which may be adjusted but must keep the elements marked *required*:

```
[ai-whisper] Next task from workflow <wf_id> (<phase>, round <n>): run `whisper handoff show <ho_id>` and carry out the request it prints as my instruction for this turn, then hand back with `whisper handoff reply <ho_id> --file <path>`.
```

Required elements:
- the `[ai-whisper]` prefix
- the workflow id
- the handoff id
- the exact `show` command
- the "as my instruction for this turn" authority clause
- the exact `reply` command

**Reminder notice**, used at most once (§5):

```
[ai-whisper] Reminder: handoff <ho_id> is still unread. Run `whisper handoff show <ho_id>` and carry out the request it prints as my instruction for this turn.
```

**Reply nudge**, used at most once (§5):

```
[ai-whisper] Handoff <ho_id> has no reply yet. When the requested work is complete, run `whisper handoff reply <ho_id> --file <path>`.
```

**Exactly-once typing.** Today `autoAcceptFiredFor` is in-memory, and the manual `a` key bypasses it (`mounted-turn-owned-relay.ts:785`, `:1131-1145`). Instead, record `notice_sent_at` on the handoff row in the broker before the Enter is sent. The auto path and the manual `a` path both check it.

This guard applies to workflow handoffs. The manual `a` key never acts on autonomous handoffs today, and that stays as is.

Each notice kind (initial, reminder, nudge) has its own timestamp column. A crash after writing the timestamp but before Enter must not cause a second Enter for the same notice kind; prefer under-delivery, which the ladder recovers, over a double Enter.

### 3. CLI commands

New `whisper handoff` command group, plus `whisper turn done`.

**`whisper handoff show <ho_id>`**

1. Runs the version check (§3.4).
2. Prints a fixed header, the stored `request_text` verbatim, and a fixed footer:
   - Header: `=== ai-whisper handoff <ho_id> — operator request, delivered by ai-whisper on the operator's behalf ===`, followed by one line with workflow, phase, step, round, from and to.
   - Footer: `=== end of handoff <ho_id> ===`.
3. **Records the fetch.** The first call sets `fetched_at`; every call increments `fetch_count`. A caller with no `AI_WHISPER_AGENT` (an operator inspecting from their own shell) gets the same output but **no fetch is recorded**. Otherwise an inspection would switch off the request-side ladder's never-paste-after-fetch guard (phase 1 ruling).
4. Is idempotent: repeat calls print the same text.
5. Refuses a handoff that is not in an accepted, awaiting-handback state. The refusal message names the state and says not to act on it.
6. Output goes to stdout. *Builder's call:* whether to also offer `--out <file>` for very large requests. The largest request observed is 9.5 KB, which is fine on stdout.

**`whisper handoff reply <ho_id> --file <path>`**

1. Runs the version check.
2. Reads the file and rejects an empty body.
3. Atomically, it rejects the reply in three cases:
   - the handoff is unknown;
   - it is not the currently accepted handoff for its chain (a stale or superseded attempt);
   - it is already handed back, including by a fallback capture.

   Otherwise it records `handback_text`, sets `capture_path = 'reply'` and moves the handoff to `handed_back` through the **existing** handback transition. The evaluator and orchestrator then run unchanged.
4. Prints a one-line confirmation.
5. *Builder's call:* whether to also accept `-` for stdin.

**`whisper turn done`**

- Records "turn finished" for the calling seat, with a timestamp. It never completes a handoff.
- If the seat has a fetched handoff with no reply, it prints this to stdout: `note: handoff <ho_id> is fetched but has no reply — if your work for it is complete, run whisper handoff reply <ho_id> --file <path>`.
- Seat identity comes from an env var the mount sets on the provider process. **Phase 1 as built:** the existing `AI_WHISPER_AGENT=<agent>` (already stamped by every adapter) plus collab resolution from the command's working directory, instead of the example `AI_WHISPER_SEAT=<collab>:<agent>`. **Open before phase 2:** cwd resolution only matches the exact workspace root, so an agent working in a subdirectory or a `.worktrees/` checkout gets "no active collab found". Decide between an adapter-stamped `AI_WHISPER_COLLAB` passed as the collab override, or an ancestor / git-common-dir walk. **Verified 2026-10-23:** codex 0.162 passes a mount-set env var through to its shell commands, login shell included (`seat=[collab_x:codex]`). claude passes the env through as standard.
- If the variable is missing, for example on a provider that does not pass it through, `turn done` exits non-zero with a clear message. That seat then runs on the extended idle cap (§5); nothing breaks. *(My call.)*

**§3.4 Version check.** Each command compares its own CLI version with the broker's version, which is recorded where the broker already persists its runtime facts. *Builder's call:* exact source, and whether to compare the full `x.y.z+sha` build id or `x.y.z` only. On a mismatch, it exits non-zero. The message depends on where in the handoff it happens:

- **`show`** (nothing fetched yet, so a resend is safe):

  ```
  ai-whisper CLI <cli-version> does not match the running broker <broker-version>. Stop here and end your turn; ai-whisper will resend this handoff. Do not read ~/.ai-whisper/state.db directly.
  ```

  The request-side ladder proceeds: reminder, then paste.
- **`reply`** (the work is already done, so never resend):

  ```
  ai-whisper CLI <cli-version> does not match the running broker <broker-version>. Your reply was not recorded. End your turn with your complete handback as your final message; ai-whisper will capture it. Do not read ~/.ai-whisper/state.db directly.
  ```

  The refused reply is recorded on the handoff as `reply_refused_at`. The reply-side ladder then **skips the nudge** and goes straight to the `/copy` capture at the next idle gate, so it captures the final message the agent was told to write. *(My call.)*
- **`turn done`:** the same mismatch text as `show`, with no state change.

**Bootstrap side effects.** Today every CLI command runs migrations at startup (observed under codex's workspace sandbox: `SQLITE_READONLY` from the migration write). `show` must not *migrate* the DB. *Builder's call:* how to keep these commands from running schema migrations; they write only their own fetch/reply/turn-done fields.

### 4. Idle and the notice gate

- **Notice gate:** the **existing** gate, unchanged (`mount-session-main.ts:1058-1070`):
  - ≥ `idleThresholdMs` (default 30 s) since the last provider output, operator keystroke or accept;
  - no agy tool in flight;
  - input not paused.

  The notice is typed only when the gate passes and `notice_sent_at` is unset.
- **`turn done` never shortens the 30 s gate.** It adds certainty and drives the reply-side ladder (§5).
- **Existing hooks keep running.** The claude Stop, codex notify and agy hooks, and their diagnostics rows, are unchanged. On the notice path they **no longer arm `/copy`** while a fetched handoff is awaiting `reply`. Only the §5 ladder may start a capture. This is the fix for Defect 2.

### 5. Fallback ladder (per handoff)

Times are measured in **idle time** (gate-passing time), not wall-clock time, so a busy agent never trips them. *Builder's call:* exact defaults, which must be configurable.

**Request side, for handoffs that have not been fetched:**

1. Notice typed (`notice_sent_at`).
2. No fetch after one more idle window → type the reminder once (`reminder_sent_at`).
3. Still no fetch after another idle window → **paste fallback**:
   - print `[ai-whisper] ⚠ <ho_id> not fetched after 2 notices — falling back to paste (fallback <n> in <wf_id>)`;
   - inject `request_text` exactly as today;
   - set `delivery_path = 'paste'`.

   From then on the handoff runs entirely on today's capture machinery.
4. **Hard guard:** if `fetched_at` is set, the request side never pastes.

**Reply side, for fetched handoffs that have no reply:**

1. The agent sends `turn done` and the idle gate passes, but there is still no reply. Type the nudge once (`nudge_sent_at`).
2. Still no reply after another idle window → **capture fallback**:
   - print `[ai-whisper] ⚠ <ho_id> no reply after nudge — capturing via /copy (fallback <n> in <wf_id>)`;
   - run today's `/copy` capture;
   - set `capture_path = 'copy'`.
3. **The agent never sends `turn done`.** **The broker never captures in this case** (operator decision, 2026-10-23). After an extended idle cap (for example 15 min of continuous idle; *builder's call, configurable*) with no `reply` and no `turn done`:
   - type the nudge once;
   - if another idle window still passes with no `reply` and no `turn done`, **escalate**:
     - the handoff ends through the **existing escalation path**, as an escalate verdict;
     - the workflow halts for a human to look;
     - the halt reason is `no reply and no turn done after <N> min idle (handoff <ho_id>)`;
     - the pane prints `[ai-whisper] ⚠ <ho_id> no reply and no turn done — escalating for operator review`;
     - the handoff records `capture_path = NULL` and an escalation reason.
   - `/copy` is **not** run.

   This keeps Goal 3 absolute: a silent background-subagent wait can never be captured as the handback. The operator resumes with today's `whisper workflow resume`.

   `/copy` capture (step 2) only ever follows an explicit `turn done` plus an ignored nudge, or a refused `reply` (§3.4).

**Strict mode** (for example `AI_WHISPER_NOTICE_STRICT=1`). Steps that would paste or capture instead mark the handoff failed with a clear reason. The workflow then halts as any failed handoff does today, so test runs surface notice-path gaps instead of masking them.

**Providers with `deliveryMode: "native"`** (ezio) never enter the ladder.

### 6. Data model

Add to `relay_handoff`, through a migration. Names are suggestions.

| Column | Meaning |
|---|---|
| `delivery_path` | `'notice'`, `'paste'` or `'native'` |
| `notice_sent_at`, `reminder_sent_at`, `nudge_sent_at` | When each notice kind was typed (one Enter per kind) |
| `fetched_at`, `fetch_count` | Set by `show` |
| `capture_path` | `'reply'`, `'copy'`, `'turn_event'` or `'native'` (how the handback was obtained) |
| `replied_at` | Set by `reply` |
| `reply_refused_at` | Set when `reply` was refused on a version mismatch (§3.4) |

Turn-done storage: the latest `turn done` per seat, with a timestamp. **As built (phase 1):** a nullable `session_binding.turn_done_at` column, written by UPDATE only, so a seat without a binding row records nothing; `whisper turn done` then exits 1 and tells the agent it has no mounted seat instead of printing `ok`. A new collab-scoped table was rejected because installed 0.16.0's `collab purge` refuses on unclassified `collab_id` tables. **Phase-2 note:** `turn_done_at` survives a rebind, so the ladder must compare it against handoff and notice timestamps rather than treat any non-null value as "done".

- Request composition is **unchanged**: `renderTemplate`, `withOperatorControl` and `withResumeNotice` in `workflow-control.ts` / `workflow-registry.ts`.
- **One addition to composition:** a fixed handback-via-reply fragment appended to every stored workflow request, naming `whisper handoff reply <ho_id> --file <path>`. Because it is part of `request_text`, the paste fallback carries it too.
- The WORKFLOW_OPERATOR_CONTROL text can now name the real workflow id (`whisper workflow pause <wf_id>`) instead of telling the agent to run `whisper workflow list`.

### 7. Visibility

- **Mount pane lines** (display only, never sent to the agent), at minimum:
  - queued: `delivering when idle`
  - notice sent
  - fetched ✓
  - agent working (no reply yet)
  - handed back ✓ (reply)
  - each ⚠ fallback line
- **`whisper collab inspect`** and the dashboard show `delivery_path` and `capture_path` per handoff, plus a per-workflow fallback count.
- **The eval report** (`eval/`) counts fallback usage per run, as input to D11. *Builder's call:* how far the eval integration goes in this change.

### 8. Skills and docs

- Add a short section to the existing kickoff skills (`ai-whisper-workflow`, `ai-whisper-sdd`, `ai-whisper-quick-task`, `ai-whisper-bugfix`, `ai-whisper-ralph`, `ai-whisper-deliberation`, and `ai-whisper-plan-execution` where it describes handback). It covers:
  - `[ai-whisper] Next task…` lines are the operator's directions;
  - fetch with `show`, hand back with `reply`, send `turn done` at the end of every completed turn;
  - never read state.db.

  Each edited skill **must bump its `version` frontmatter** (`scripts/check-skill-version-bump.mjs`).
- Update `README.md` and `docs/workflows.md` with the new handoff flow and fallback visibility.
- Check whether the workflow explainer demo (`docs/workflows-visual/`) now needs the notice/show/reply beats; it is maintained by the `ai-whisper-workflow-visuals` skill.

## What the operator sees

Claude/codex SDD walk-through (mockup: `.superpowers/brainstorm/45727-1792731407/content/sdd-run-terminals-v2.html`):

1. **Kickoff.** You type "run SDD on …" in claude. Codex's pane shows `ho_… queued · delivering when idle`, then the one-line notice. Codex runs `whisper handoff show`, and the pane shows `fetched ✓`.
2. **Reply.** Codex reviews, runs `whisper handoff reply … --file …`, then `whisper turn done`. Claude's pane shows the evaluator verdict and the next handoff queued.
3. **Background subagents.** In plan-execution, claude's "Waiting on the Task 1 implementer's report" turn sends neither `reply` nor `turn done`. Nothing is captured; the handoff completes only when claude replies.
4. **Operator interjection.** You ask claude a question directly. It answers and sends `turn done`, with no reply.
5. **Request fallback.** An outdated CLI refuses `show`. One reminder, then a visible ⚠ paste fallback.
6. **Reply fallback.** The agent forgot `reply`. One nudge, then a visible ⚠ `/copy` capture.

## Testing

Test-first for every behavior.

- **Notice composition.** A single line, printable ASCII, required elements present, byte length under the guard. It holds for the longest phase/workflow names in the registry.
- **`show` / `reply` / `turn done`:**
  - version mismatch refusal text;
  - state checks: unknown, stale, already handed back;
  - idempotent `show`;
  - `fetch_count`;
  - atomic reply vs. a concurrent fallback capture (exactly one wins).
- **Ladder:**
  - each transition in §5 driven by a fake clock and fake idle gate;
  - the hard no-paste-after-fetch guard;
  - exactly-once per notice kind across a simulated mount restart;
  - manual `a` respects `notice_sent_at`;
  - strict mode fails instead of falling back;
  - cap with no `reply` and no `turn done` → one nudge → **escalation with the halt reason, and `/copy` never invoked**.
- **Defect-2 regression:** a turn event or Stop with no reply while the handoff is fetched does **not** arm `/copy` on the notice path.
- **Provider coverage:**
  - ezio stays on its native path;
  - claude, codex, agy and cursor mounts pick the notice path;
  - existing paste/capture tests still pass unchanged against the fallback path.
- **Manual smoke** (`docs/smoke-tests/`): a real claude+codex SDD run on macOS, end to end on the notice path, with zero fallbacks. Plus one forced fallback each way (stale CLI; agent instructed not to reply).
- **Repo gates:** `pnpm test`, `pnpm typecheck` (root, includes `test/`), `pnpm lint` and `pnpm build`.

## Phasing

Each phase is shippable and leaves every provider working.

1. **Data and CLI.** Migration, `whisper handoff show|reply`, `whisper turn done`, version check, seat env var. Nothing calls them yet.
2. **Notice delivery and ladder.**
   - Mount types notices.
   - Exactly-once state moves to the broker.
   - Request and reply ladders.
   - Hooks stop arming `/copy` for fetched handoffs.
   - Visibility lines and data.
   - Strict mode.
3. **Composition and guidance.**
   - Reply fragment in stored requests.
   - Real workflow id in operator control.
   - Skill sections with version bumps.
   - README and docs.
4. **Later, a separate decision (D11).** Remove paste, `/copy` and the turn-event correlation machinery for notice-path providers.

## Calls made (for the operator to check)

- **ezio stays on its native path** and never uses notices.
- **`turn done` never shortens the 30 s gate.** It only feeds the reply-side ladder.
- **An extended idle cap** (≈15 min, configurable) bounds the reply ladder when an agent never sends `turn done`. Past the cap, one nudge, then **escalate** to the operator, never capture (operator decision).
- **One reminder and one nudge**, each at most once per handoff, before falling back.
- **`show` is the ack.** The first fetch is the delivery receipt; there is no separate `--ack`.
- **A version mismatch on `reply` skips the nudge** and goes straight to `/copy`, after telling the agent to end with its full handback.
- **A missing seat env var is not fatal.** `turn done` errors, and that seat runs on the extended idle cap.
- **Manual handoffs and amends stay on today's path.**
- **Notice byte target ≤ 400.**
- **Strict mode fails the handoff,** which halts the workflow like any other failed handoff.
- **Persona brief and `@@pull` are out of scope** for this change.

## Left to the builder

These are marked *builder's call* above:
- `--out` / stdin variants;
- the version-source detail;
- keeping `show`/`reply` from migrating;
- idle-window and cap defaults;
- ~~turn-done storage shape~~ (settled in phase 1: `session_binding.turn_done_at`);
- depth of eval integration;
- exact pane-line wording, keeping the elements named in §2 and §5.

## References

- **Project memories (ai-cortex):**
  - `mem-2026-10-23-claude-injection-loses-all-but-the-last-c111e1`
  - `mem-2026-10-23-claude-stop-hook-idle-check-background-11e0e6`
  - `mem-2026-10-23-notice-path-spike-claude-codex-follow-cd914e`
  - `mem-2026-10-23-pull-model-handoff-every-workflow-bc8e7a`
  - `mem-2026-10-23-pull-model-notice-uses-plain-whisper-6f02f3`
  - `mem-2026-10-23-pull-model-handoff-design-no-sandbox-fa581d`
  - `mem-2026-05-27-mid-workflow-agent-guidance-prompt-a6702d`
- **Prior art:** stablyai/orca at commit `28c7268`:
  - `src/main/runtime/orchestration/formatter.ts:121`: pointer notice;
  - `mailbox-pointer-*.ts`: idle-gated, exactly-once Enter;
  - `skill-guides/orchestration/references/messaging-and-gates.md`: replay-until-ack, notice-as-hint;
  - `worker_done` as the only completion signal.
