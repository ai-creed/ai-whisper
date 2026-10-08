# CLI argument parser: subcommands

## Task
`src/args.ts` exports `parseArgs(argv, spec)`, which handles `--flag`, `--flag=value`, `--flag value` and the `--` terminator against a spec of global flags. Add subcommands. The spec gains an optional `commands?: Record<string, { flags: Record<string, "boolean" | "string">; help?: string }>`. The first positional that names a command selects it; that command's flags are parsed from then on, and global flags stay valid anywhere. The result gains `command: string | null` and `commandFlags: Record<string, string | boolean>`; flags that belong to the selected command land in `commandFlags`, global flags in `flags`. A flag that is not valid at that point throws an `Error` with the message `unknown flag --x`. Add `renderHelp(spec): string` in a new `src/help.ts`, which lists the global flags and then each command with its help line and flags.

## Scope
- `src/args.ts`
- `src/help.ts`
- `test/args.test.ts`

## Acceptance criteria
- `["build", "--out", "dist"]` with a command `build` that declares `out: "string"` gives `command: "build"` and `commandFlags: { out: "dist" }`; the command name is not left in `positionals`.
- A global flag such as `--verbose` lands in `flags` whether it appears before or after the command name.
- A command flag used before the command name is an unknown flag error.
- With no command on the line (or no `commands` in the spec) `command` is `null` and `commandFlags` is `{}`.
- After a `--` terminator every remaining token is a positional, including inside a command, and is never matched against command names.
- An unknown flag throws an `Error` whose message is exactly `unknown flag --x` (with the flag's own name in place of `x`).
- `renderHelp` output contains each command name, each command's `help` text, and every flag name prefixed with `--`; a flag is shown as `  --name  (type)`.
- `parseArgs` keeps working for specs without `commands`, and the existing behaviour and tests stay unchanged.
- `npm run typecheck`, `npm run lint`, and `npm test` pass.
