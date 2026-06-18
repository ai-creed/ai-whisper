# ezio `/resume` and `/rename` slash commands — pointer

The design spec for adding ezio's `/resume` (switch the live session to a past
one) and `/rename` (title the current session) commands — working in both
standalone ezio and a mounted ezio pane — lives in the **ai-ezio** repo, alongside
the rest of the ezio design canon (its predecessor
`2026-06-14-ezio-mounted-slash-commands-design.md` and the resume/transcript
specs):

> `ai-ezio/docs/superpowers/specs/2026-06-18-ezio-resume-rename-commands-design.md`

The whisper-side work (Stage 3 of that spec) lands here:

- `packages/shared/src/interactive-session.ts` — optional `runInteractiveOverlay`
  (suspend the pane line reader, hand the adapter a raw key stream for the
  `/resume` arrow picker, then restore)
- `packages/cli/src/runtime/live-session.ts` — implement the overlay
- `packages/adapter-ai-ezio/src/ai-ezio-engine.ts` — widen the engine facet with
  `resume`
- `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts` — track
  `currentSessionId`, wire the title-store + `resume` capabilities into the mounted
  `SlashContext`, and re-do post-respawn wiring (host re-register, driver
  re-point, banner re-render)

**Rollout (stale-bundle gotcha):** ai-ezio changes do not reach mounted mode until
ai-whisper re-bundles. After the ai-ezio stages land: `pnpm install` + `pnpm -r
build` here, reinstall the global `whisper`, restart the collab.
