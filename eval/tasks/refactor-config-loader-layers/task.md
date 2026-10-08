# Config loader: restructure into layered sources with provenance

## Task
`loadConfig` in `src/config.ts` builds an application config from four inputs (`defaults`, an optional `file` holding JSON text, `env`, and optional `overrides`) using ad-hoc inline code: `APP_` prefix parsing with `__` nesting, JSON file parsing and a deep merge all live in one function. Restructure it into layered sources with a provenance-recording merge, without changing the merged config it produces for any input.

**Data model**
- `Source` is `{ name: string; load(): Record<string, unknown> }`, exported from `src/merge.ts`. A source that has nothing to contribute returns `{}`.
- There are four sources, one per module under `src/sources/`: `defaultsSource(defaults)` in `defaults.ts` (name `defaults`), `fileSource(text)` in `file.ts` (name `file`; `text` is the file's JSON text or `undefined`), `envSource(env)` in `env.ts` (name `env`), and `overridesSource(overrides)` in `overrides.ts` (name `overrides`). Each exports its factory function and nothing else is required.
- `src/merge.ts` exports `mergeSources(sources)`, a deep merge that applies the sources in the order given and records provenance as it goes. It returns `{ value, provenance }`.
- `provenance` maps each leaf path of `value`, written `a.b.c`, to the `name` of the source whose value won. A leaf is any non-object value, including arrays and `null`; an array is one leaf, so provenance points at the array's own path and never at its elements.

**Public API**
- `loadConfig(input)` keeps its input type and now returns `{ value, provenance, explain }`. It loads the sources in the fixed order defaults, then file, then env, then overrides, so later sources win.
- `value` must be byte-identical (compared with `JSON.stringify`, so key order counts) to what `loadConfig` returned before this change, for every input. This includes: plain objects merge recursively, arrays and other leaves replace rather than merge, a scalar can replace an object and an object can replace a scalar, `undefined` values are skipped, and inputs are never mutated.
- Provenance is exact: it contains precisely the leaf paths present in `value`. When a later source replaces a subtree, the provenance entries of the replaced leaves are removed, and the new leaves carry the new source's name. A source that returns nothing contributes no provenance entries.
- `explain(path)` returns `"<path> = <json> (from <source>)"` where `<json>` is `JSON.stringify` of the value found at that path, for example `a.b = "x" (from file)` or `port = 3000 (from defaults)`. For a path that has no provenance entry it returns `"<path> is not set"`.
- Env parsing rules are unchanged: only names starting with `APP_` count, the rest of the name is lowercased and split on `__` into a nested path, values stay strings with no coercion (`APP_A__B=1` gives `{ a: { b: "1" } }`), and names that would produce an empty path segment are ignored.
- `src/config.ts` becomes a thin composition: it must no longer contain the env-prefix logic (no `APP_` text), the JSON parsing or the merge itself. Each source module must be importable and usable on its own.
- The existing tests call `loadConfig(...)` and compare the whole result, so they must be updated in `test/config.test.ts` to read `.value`. Their expectations stay exactly as they are.

**Error handling**
- Invalid JSON in `file` throws the `SyntaxError` from `JSON.parse`; JSON that is not an object throws `config file must contain a JSON object`. An empty `file` string counts as no file. Both are unchanged.
- `loadConfig` stays synchronous and performs no I/O.

**Non-goals**
- New sources, new config formats, validation, or schema checking of the config.
- Async loading or reading files from disk.
- Type coercion of env values.

Add tests for the merge and provenance behaviour in `test/merge.test.ts` and `test/provenance.test.ts`.

## Scope
- `src/config.ts`
- `src/merge.ts`
- `src/sources/defaults.ts`
- `src/sources/file.ts`
- `src/sources/env.ts`
- `src/sources/overrides.ts`
- `test/config.test.ts`
- `test/merge.test.ts`
- `test/provenance.test.ts`

## Acceptance criteria
- `value` is byte-identical (`JSON.stringify`) to the previous output for the existing test cases.
- `provenance["a.b"]` is the last source that set that path.
- Arrays are replaced, not merged, as before, and provenance points at the array's own path.
- `explain("a.b")` returns exactly `a.b = <json> (from <source>)`.
- A source that returns nothing contributes no provenance entries.
- Sources load in the fixed order defaults, file, env, overrides.
- `src/config.ts` no longer contains the env-prefix logic: its text has no `APP_`.
- `npm run typecheck`, `npm run lint`, and `npm test` pass; the expectations of the existing tests are unchanged.
