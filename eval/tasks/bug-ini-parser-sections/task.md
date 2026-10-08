# INI parser drops sections, keys and quoted semicolons

## Task
Three inputs to `parseIni` in `src/ini.ts` produce wrong output. `parseIni("[a]\nx=1\n[b]\ny=2\n[a]\nz=3")` returns section `a` as `{ z: "3" }`, losing `x`; section `a` is expected to be `{ x: "1", z: "3" }`. `parseIni('[s]\nk = "v;w"')` returns `k` as `"v"`, but `"v;w"` is expected. `parseIni("k = 1\n[a]\nx = 2")` drops `k`; it is expected under the `""` (global) section as `{ "": { k: "1" }, a: { x: "2" } }`. Fix the parser so these and related inputs are correct.

## Scope
- `src/ini.ts`
- `test/ini.test.ts`

## Acceptance criteria
- A repeated `[section]` header merges into the earlier section: `[a]\nx=1\n[b]\ny=2\n[a]\nz=3` gives `a` equal to `{ x: "1", z: "3" }`.
- A later duplicate key within a merged section overrides the earlier one.
- A `;` or `#` inside a double-quoted value is part of the value: `k = "v;w"` gives `v;w`.
- Keys that appear before any section header land in the `""` section.
- An inline comment after an unquoted value is still stripped: `k = v ; c` gives `v`.
- An escaped quote inside a quoted value is kept as a plain quote: `k = "a\"b"` gives `a"b`.
- Blank and whitespace-only lines are ignored.
- The existing tests keep passing unchanged, and `npm run typecheck`, `npm run lint`, and `npm test` pass.
