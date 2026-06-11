# AGENTS

## Project Summary

- `ai-whisper` is a local collaboration bridge for paired AI agent sessions.
- The architecture is centered on shared contracts, a broker runtime, a companion/provider model, and the `whisper` CLI.
- Implementation is phase-based. Do not treat this repo as an open-ended feature sandbox.

## Source Of Truth

- Tracked architecture and product decisions live in `docs/superpowers/specs/`.
- Local execution plans live in `docs/superpowers/plans/`.
- `docs/superpowers/plans/` is local-only and git-ignored. Do not commit or re-track files from that directory.

## Repo Layout

- `packages/shared`: schemas, IDs, literals, and shared contract primitives.
- `packages/broker`: broker runtime and storage bootstrap.
- `packages/cli`: `whisper` command surface.
- `packages/companion-core`: companion runtime.
- `packages/adapter-codex`: Codex provider integration.
- `packages/adapter-claude`: Claude provider integration.

## Workflow Rules

- Do not implement directly on `master` unless explicitly instructed.
- Use a git worktree for phase or feature work.
- Default worktree location is `.worktrees/`.
- `.worktrees/` must remain git-ignored.
- Work from approved specs first, then an approved local phase plan, then implementation.
- Do not skip ahead into later phases without review and approval.
- When executing an approved implementation plan with subagents, follow the bundled `ai-whisper-plan-execution` skill (`packages/cli/skills/ai-whisper-plan-execution/SKILL.md`) for fan-out structure and model allocation.

## Preferred Sequence

1. Review current repo state.
2. Read the relevant tracked spec documents.
3. Read or write the local phase plan.
4. Create a worktree.
5. Implement in small scoped commits.
6. Verify with repo commands.
7. Ask before merging into `master`.
8. Wait for code review before pushing to remote.
9. Review the current phase before planning the next one.

## Branch And Merge Policy

- `master` is the protected base branch.
- Use worktrees for phase or feature work, not PRs.
- Always ask before merging back to `master`.
- After merging to `master`, wait for code review before pushing to remote. Do not push without explicit approval.
- Keep commits small and scoped to one task or checkpoint.

## Verification Rules

- Before claiming work is complete, run the relevant checks:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
- Report real failures clearly instead of hand-waving them.
- If verification is not clean, the phase is not complete.

## Documentation Policy

- Update tracked specs when architecture decisions change.
- Update `README.md` for user-facing repo changes.
- Keep `AGENTS.md` procedural and stable.
- Do not duplicate full spec content here; refer to the tracked spec documents instead.

## Current Working Mode

- Work only on the currently approved phase.
- If phase scope is unclear, stop and clarify before implementation.
- If implementation exposes a design gap, update the design or plan before continuing.
