# What each workflow does

Reference prose for the invoking agent's understanding. It is documentation,
not a runtime step, and must NOT be emitted after kickoff — doing so would
violate the exactly-one-line report/exit contract.

- **SDD (`spec-driven-development`)** turns an approved spec into an
  implementation plan, has the plan reviewed, then executes it with reviewer
  gates until handback.
- **Bugfix (`complex-bug-fixing`)** runs diagnosis → fix-and-verify →
  post-mortem: the implementer reproduces the bug (committed RED test
  preferred) and writes a diagnosis artifact; an adversarial reviewer
  independently reproduces before the gate opens; the fix turns the
  reproduction GREEN and is verified across the blast radius. Diagnosis and
  post-mortem artifacts live in the gitignored run dir
  `.ai-whisper/bugfix/<workflowId>/` — only the fix and the reproduction test
  land in the repo.
- **Deliberation (`deliberation`)** is the pre-spec stage for a fuzzy idea:
  four propose→review→fix layers (objectives, approaches, tradeoffs,
  synthesis), each adversarially challenged, producing a findings document
  committed to `docs/superpowers/deliberations/` — a document, never code.
- **Ralph (`ralph-loop`)** grinds the goal chunk-by-chunk: each iteration the
  implementer picks the next smallest independently-verifiable chunk, a
  reviewer checks it, and each accepted chunk is auto-committed; an acceptance
  review gates final completion against the goal's criteria. Durable memory
  lives under `.ai-whisper/ralph/<workflowId>/` (`PROGRESS.md`,
  `LEARNINGS.md`).

Watch any of them on `whisper collab dashboard`; do not babysit from chat.
