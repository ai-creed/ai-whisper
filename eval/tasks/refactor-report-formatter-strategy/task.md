# Replace the report format switch with a formatter registry

## Task
`formatReport` in `src/format.ts` is one large `switch` over the format name with duplicated header and row logic. Replace it with a formatter registry. `src/registry.ts` exports `type Formatter = (report: Report) => string`, `registerFormatter(name, formatter)`, `getFormatter(name)` and `listFormats()`. The existing `text`, `json` and `csv` formatters move, with their logic unchanged, into `src/formatters/index.ts`, which registers them when imported. `formatReport` takes `format: string` and delegates to the registry. Then add a new `markdown` format in `src/formatters/markdown.ts`, registered only through the registry and never mentioned in `src/format.ts`.

## Scope
- `src/format.ts`
- `src/registry.ts`
- `src/formatters/index.ts`
- `src/formatters/markdown.ts`
- `test/format.test.ts`

## Acceptance criteria
- The output of `text`, `json` and `csv` stays byte-identical, and the existing tests pass unchanged.
- `formatReport(report, "markdown")` returns `# <title>`, a blank line, then a GFM table: `| name | value |`, `|---|---|`, and one `| <name> | <value> |` line per row, joined with `\n` and with no trailing newline. For rows `a: 1` and `b: 2` titled `T` that is `# T\n\n| name | value |\n|---|---|\n| a | 1 |\n| b | 2 |`.
- `listFormats()` returns `["text", "json", "csv", "markdown"]`, in registration order, once `formatReport` is available (importing `src/format.ts` is enough to register every format).
- `getFormatter("nope")` throws an error whose message is `unknown format nope`, and `formatReport(report, "nope")` throws the same error.
- `registerFormatter` throws when the name is already registered.
- `src/format.ts` contains no `switch` statement and no per-format logic: the source text has no `switch` and no `case "`.
