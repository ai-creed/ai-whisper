# Notice-Path Handoff Smoke Test

Manual checklist for phase 2 of notice-path handoff delivery: mounts type a
one-line notice, the agent fetches with `whisper handoff show <id>` and replies
with `whisper handoff reply <id> --file <path>`, and an idle-gated ladder
recovers missed steps. Run it after merge and before any release. It burns
real tokens and is operator-run, not CI.

## Ground rules

- Every run uses a scratch state root and a scratch workspace. Never run it
  against your real state:

  ```bash
  export AI_WHISPER_STATE_ROOT="$(mktemp -d)/state"
  SCRATCH_WS="$(mktemp -d)/ws" && mkdir -p "$SCRATCH_WS" && cd "$SCRATCH_WS" && git init
  ```

- Use macOS with real `claude` and `codex` mounts (`whisper collab mount`).
- Start the workflow with `whisper workflow start` (SDD on a small approved
  spec) unless a run says otherwise.
- `<n>` in a pane line is the workflow's running fallback count.
- `whisper collab inspect` shows the `notice path: <n> fallback(s)` line only
  while the workflow is running or paused. Run it mid-run (between handoffs,
  before the final phase completes); the line disappears once the workflow
  completes or halts. After a halt, use the dashboard evidence `via ...`
  labels instead.

Pane lines referenced below (display only):

| Line | Meaning |
|---|---|
| `[ai-whisper] <ho_id> queued · <phase> <step> r<n> · delivering when idle` | handoff waiting for idle |
| `[ai-whisper] <ho_id> notice sent` | one-line notice typed |
| `[ai-whisper] <ho_id> fetched ✓` | agent ran `handoff show` (once) |
| `[ai-whisper] <ho_id> handed back ✓ (reply)` | agent ran `handoff reply` |
| `[ai-whisper] ⚠ <ho_id> not fetched after 2 notices — falling back to paste (fallback <n> in <wf_id>)` | request fallback |
| `[ai-whisper] ⚠ <ho_id> no reply after nudge — capturing via /copy (fallback <n> in <wf_id>)` | reply fallback |
| `[ai-whisper] ⚠ <ho_id> no reply and no turn done — escalating for operator review` | escalation |

## (a) Happy path, zero fallbacks

Setup: scratch state root and workspace; claude and codex mounted.

Steps:
1. Start an SDD run on a small spec and let it finish end to end.
2. While the workflow is still running (between handoffs, before the final phase completes), run `whisper collab inspect`.

Expected:
- [ ] Each handoff shows `queued`, `notice sent`, `fetched ✓`, then `handed back ✓ (reply)`.
- [ ] No line starting `[ai-whisper] ⚠` appears in either pane.
- [ ] The workflow reaches done.
- [ ] Mid-run, `collab inspect` shows `notice path: 0 fallback(s)` for the workflow (the line is absent once the workflow completes).
- [ ] Dashboard evidence rows show `via notice/reply`.

## (b) Forced request-side fallback

Setup: put a `whisper` stub that exits non-zero for `handoff` first on the
target provider's PATH (for example a script that rejects `handoff` and
otherwise execs the real `whisper`), then mount.

Steps:
1. Start a workflow so the stubbed provider receives a handoff.

Expected:
- [ ] `queued`, then `notice sent`.
- [ ] One reminder line is typed after an idle window (`Reminder: handoff <ho_id> is still unread`).
- [ ] Then `⚠ <ho_id> not fetched after 2 notices — falling back to paste (fallback 1 in <wf_id>)`.
- [ ] Today's paste and capture follow; the workflow continues.
- [ ] While the workflow is still running, `collab inspect` shows `notice path: 1 fallback(s) in <wf_id>`.
- [ ] The evidence row shows `via paste/...`.

## (c) Forced reply-side fallback

Setup: normal PATH. Tell the agent in its pane to fetch and do the work but
skip `whisper handoff reply`, still running `whisper turn done` at turn end.

Steps:
1. Start a workflow; let the agent finish its turn without replying.

Expected:
- [ ] `fetched ✓` appears, no `handed back ✓`.
- [ ] A nudge is typed (`Handoff <ho_id> has no reply yet`).
- [ ] If still ignored: `⚠ <ho_id> no reply after nudge — capturing via /copy (fallback <n> in <wf_id>)`.
- [ ] The `/copy` capture completes and the workflow continues.
- [ ] The evidence row shows `via notice/copy`; while the workflow is still running, `collab inspect` counts the fallback.

## (d) D12: no reply and no turn done

Setup: `export AI_WHISPER_NOTICE_IDLE_CAP_MS=60000` before mounting. Tell the
agent to skip both `whisper handoff reply` and `whisper turn done`.

Steps:
1. Start a workflow; let the agent go idle after fetching.

Expected:
- [ ] After about 60 s of idle, a nudge is typed.
- [ ] Then `⚠ <ho_id> no reply and no turn done — escalating for operator review`.
- [ ] The workflow halts with reason `no reply and no turn done after 1 min idle (handoff <ho_id>)`.
- [ ] No `/copy` capture occurs.
- [ ] The workflow ends halted, so `collab inspect` no longer shows the notice-path line. Check the count before the escalation, or read the dashboard evidence `via ...` labels after the halt.

## (e) Strict mode with (b)

Setup: repeat (b) with `export AI_WHISPER_NOTICE_STRICT=1`.

Expected:
- [ ] Reminder is typed as in (b).
- [ ] Instead of a paste, the workflow halts with reason `strict mode: paste fallback suppressed (handoff <ho_id>)`.
- [ ] No handoff text is pasted into the pane.
- [ ] The workflow ends halted, so `collab inspect` no longer shows the notice-path line. Check the count before the halt, or read the dashboard evidence `via ...` labels after it.

## (f) Kill switch

Setup: `export AI_WHISPER_NOTICE_PATH=off` before mounting.

Steps:
1. Start a workflow end to end.

Expected:
- [ ] Today's behavior: the full request is pasted, no one-line notice is typed, and capture works as before.
- [ ] No `fetched ✓` / `handed back ✓ (reply)` lines.
- [ ] Evidence rows show `via paste/...`; while the workflow is running, `collab inspect` shows a fallback count equal to the number of handoffs delivered so far. Paste-mode handoffs (`delivery_path='paste'`) count as fallbacks by definition.

## Cleanup

Remove the scratch state root and workspace; unset the `AI_WHISPER_*` variables.
