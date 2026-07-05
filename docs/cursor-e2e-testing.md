# Cursor adapter — end-to-end test guide

Step-by-step manual e2e for the **Cursor** adapter (`agent` CLI) on the
`feat/adapter-cursor` branch. It validates two things:

1. The **one-shot / companion** path (`whisper collab tell --target cursor`).
2. The **mounted paired workflow** — cursor + claude running
   `spec-driven-development`, exercising the mounted-handback **transcript
   capture** and the capture-hardening fixes (prompt-anchored selection,
   freshness floor, cursor-authoritative classification, breadcrumb logging).

The automated suite already covers the units; this guide is the human-driven
run against the real `agent` CLI on a machine with Cursor quota. It is written
to be runnable on limited quota — the example spec is deliberately tiny.

---

## 0. Prerequisites

On the test machine:

```bash
# 1. Get the branch
git fetch origin
git checkout feat/adapter-cursor
git pull

# 2. The ai-ezio sibling repo must exist next to ai-whisper and be built
#    (workspace deps resolve to ../ai-ezio/...). Skip if already present.
#    git clone <ai-ezio-remote> ../ai-ezio && (cd ../ai-ezio && pnpm install && pnpm build)

# 3. Install + build ai-whisper
pnpm install
pnpm build
```

**Prereqs to confirm:**

- **Cursor CLI** installed and signed in — the `agent` command runs and has quota.
  (If your binary is named differently, set `AI_WHISPER_CURSOR_CMD`.)
- **Claude Code CLI** (`claude`) signed in — the partner agent for the paired run.
- **An evaluator** — workflows refuse to start without one. Either:
  - `~/.ai-whisper/config.json` with an Ollama provider (local, no key), e.g.
    ```json
    { "evaluator": { "provider": "ollama",
        "ollama": { "model": "qwen2.5:7b-instruct" } } }
    ```
    and `ollama serve` running; or
  - Anthropic/OpenAI credentials — see [Evaluator configuration](evaluator-configuration.md).

### The `whisper` binary gotcha (read this)

The mounted agent runs a **bare `whisper`** from inside its own shell, so it must
resolve to **this branch's build**, not a globally-installed `ai-whisper`. A shell
alias will **not** work — child processes don't inherit aliases. Point the global
binary at this build (adjust the target dir to your global bin):

```bash
# find where the global whisper lives
which whisper
# repoint it at this build (example path — use your own bin dir)
ln -sf "$(pwd)/packages/cli/dist/bin/whisper.js" "$(dirname "$(which whisper)")/whisper"

# verify it's THIS build and lists cursor
whisper --version
whisper collab mount --help    # the <agent> arg help must list "cursor"
```

When you're done testing, restore your previous global symlink.

---

## Part A — one-shot smoke (fast, ~1 turn of quota)

Confirms the provider builds the right `agent` invocation and parses its JSON
envelope. Run from any workspace dir:

```bash
whisper collab start                 # starts a broker for this workspace
whisper collab tell --target cursor "Reply with exactly: CURSOR-E2E-OK"
```

**Pass:** the reply prints `CURSOR-E2E-OK` (the text extracted from Cursor's
`{ ..., "result": "..." }` envelope). A file-backed variant:

```bash
whisper collab tell --target cursor "Create a file hello.txt containing the single word: ok"
cat hello.txt          # -> ok
```

Stop when done: `whisper collab stop`.

---

## Part B — mounted paired workflow (the real test)

Two terminals in the **same workspace**. Cursor is the implementer, Claude the
reviewer, driving `spec-driven-development` against a tiny spec.

### B.1 Create the example spec

In your test workspace, create `docs/spec.md` (small on purpose — one file, one
test, so it finishes in a few turns even on limited quota):

```markdown
# Spec: string-utils `slugify`

Add a `slugify(input: string): string` helper.

## Requirements
- New file `src/string-utils.js`, exporting `slugify`.
- `slugify` lowercases the input, trims leading/trailing whitespace, and
  replaces every run of non-alphanumeric characters with a single hyphen `-`.
- No leading or trailing hyphens in the result.
- Add `test/string-utils.test.js` covering: a basic phrase
  (`"Hello, World!"` -> `"hello-world"`), collapsing repeated separators
  (`"a  --  b"` -> `"a-b"`), and trimming (`"  Hi  "` -> `"hi"`).

## Acceptance
- The test file runs and all cases pass.
- `slugify` is pure and has no external dependencies.
```

> Prefer an even smaller run? Replace the spec body with: *"Add `src/add.js`
> exporting `add(a,b)` returning `a+b`, plus `test/add.test.js` with one passing
> case."* The flow is identical; it just uses fewer turns.

### B.2 Mount both agents

```bash
# make sure no stale collab is running
whisper collab stop

# terminal 1 — Cursor (implementer)
whisper collab mount cursor

# terminal 2 — Claude (reviewer)
whisper collab mount claude
```

The first `mount` creates the collab + broker; the second binds the partner.

### B.3 Watch the dashboard (third terminal)

```bash
whisper collab dashboard
```

Both agents should show as **bound**. If the dashboard shows "no active collabs"
or the workflow later says "only 1 agent is bound," the mounted `whisper` is a
stale global — fix the binary resolution (see the gotcha in §0).

### B.4 Kick off the workflow from the Cursor terminal

In **terminal 1 (Cursor)**, type in plain language:

```text
Run spec-driven-development using docs/spec.md
```

The agent you trigger from becomes the **implementer** (cursor); the other
(claude) becomes the **reviewer**.

### B.5 What to watch

On the dashboard, a healthy run looks like:

- The phase advances **spec-refining → planning → implementing → review**, with
  the baton passing between cursor and claude.
- After each **cursor** turn, its work is **handed back non-empty** — the phase
  moves forward rather than stalling or escalating on an empty handback.
- The loop terminates with the deliverable **approved** (or the round budget
  exhausted), and `src/string-utils.js` + `test/string-utils.test.js` exist and
  the tests pass.

### B.6 The capture breadcrumb log (primary diagnostic)

Every mounted-cursor capture decision is appended here:

```bash
tail -f ~/.ai-whisper/logs/cursor-capture.jsonl
```

Each line is one JSON record:

| field | meaning |
|---|---|
| `candidateCount` | transcripts considered after the freshness floor |
| `matchedCount`   | how many matched the delivered instruction (prompt anchor) |
| `chosenPath`     | which transcript was selected |
| `textLen`        | length of the captured handback text |
| `status`         | `captured` / `timed_out` / `degraded_pty_only` |

A healthy cursor turn shows `matchedCount ≥ 1`, a `chosenPath`, `textLen > 0`,
`status: "captured"`.

---

## Pass / fail criteria

**Pass** when:

- Part A prints `CURSOR-E2E-OK` and writes the file.
- Part B completes the SDD loop with cursor's implementation handbacks landing
  (non-empty), the deliverable files present, and their tests passing.
- The breadcrumb log shows `captured` with `textLen > 0` for cursor turns.

**Fail / investigate** if a cursor turn stalls or escalates on an empty
handback — capture the breadcrumb line(s) for that turn and the dashboard state.

---

## Troubleshooting

- **"Only 1 agent is bound" / "no active collabs":** the mounted `whisper` is a
  stale global. Repoint the global binary at this build (§0), re-`mount`.
- **Cursor turn escalates with an empty handback:** read the breadcrumb line for
  that turn:
  - `status: "degraded_pty_only"` → no transcript found (flush/permissions).
  - `status: "timed_out"` with `matchedCount: 0` → the delivered instruction
    didn't match the transcript's user entry (prompt anchor missed). Capture the
    line and the `~/.cursor/projects/.../agent-transcripts/...` transcript.
  - `candidateCount: 0` → the freshness floor filtered everything; likely a
    broker/filesystem clock skew. Widen it via `clockSkewMs` (see
    `captureCursorHandback`) if this recurs.
- **`/copy` shows a picker:** expected — Cursor's `/copy` is interactive, which
  is exactly why the mounted path reads the on-disk transcript instead of the
  clipboard. No action needed.
- **Out of Cursor quota:** use the smaller spec variant in §B.1, or run only
  Part A.

---

## Scope

This validates the adapter and the mounted-capture hardening against the real
CLI. The one-shot/companion path and unit behaviors are covered by the automated
suite (`test/cursor-*.test.ts`, `test/parse-cursor-output.test.ts`,
`test/mounted-turn-owned-relay.test.ts`).
