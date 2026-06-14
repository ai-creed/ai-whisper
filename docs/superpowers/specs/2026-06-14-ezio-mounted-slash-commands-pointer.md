# ezio mounted-mode slash commands — pointer

The design spec for making ezio's slash commands work inside a mounted ezio
(`whisper collab mount ezio`) lives in the **ai-ezio** repo, where its
predecessor (`2026-06-08-ezio-slash-commands-design.md`) and the rest of the
ezio design canon live:

> `ai-ezio/docs/superpowers/specs/2026-06-14-ezio-mounted-slash-commands-design.md`

The whisper-side work (Stages 2-3 of that spec) lands here:

- `packages/shared/src/interactive-session.ts` — optional `tryConsumeLocalCommand`
- `packages/adapter-ai-ezio/src/ai-ezio-engine.ts` — widen the engine facet
- `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts` — build the
  `SlashController` with mounted capabilities and implement the seam
- `packages/cli/src/runtime/live-session.ts` — the operator-line host hook
