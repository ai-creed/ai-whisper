# Fixture toolchain

Exact-pinned devDependencies shared by every `eval/tasks/*/fixture`. Install once:

    pnpm eval -- toolchain

The runner installs this package OUTSIDE the repository (`--toolchain-root`, default
`~/.ai-whisper-eval/toolchain`) and symlinks that `node_modules` into each fresh fixture copy, so
nothing reachable from a workspace resolves into this repo. Fixture `package.json` files declare
scripts only (typecheck/lint/test) and no dependencies.
Pins are exact on purpose: they are part of the campaign's recorded environment.
