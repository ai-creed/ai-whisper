# Path normalizer mishandles parent segments and the root

## Task
Three inputs to `normalizePath` in `src/normalize.ts` produce wrong output. `normalizePath("/../a")` returns `"//a"`, but `"/a"` is expected. `normalizePath("/")` returns `""`, but `"/"` is expected. `normalizePath("../a")` returns `"a"`, but `"../a"` is expected. Fix the normalizer so these and related inputs are correct.

## Scope
- `src/normalize.ts`
- `test/normalize.test.ts`

## Acceptance criteria
- `normalizePath("/../a")` returns `"/a"`.
- `normalizePath("/")` returns `"/"`.
- `normalizePath("../a")` returns `"../a"`.
- `normalizePath("/..")` returns `"/"`.
- `normalizePath("a/../..")` returns `".."`.
- `normalizePath("a/../../b")` returns `"../b"`.
- `normalizePath("./")` returns `"."`.
- `normalizePath("")` returns `"."`.
- `normalizePath("/a/b/")` returns `"/a/b"`.
- The existing tests keep passing unchanged, and `npm run typecheck`, `npm run lint`, and `npm test` pass.
