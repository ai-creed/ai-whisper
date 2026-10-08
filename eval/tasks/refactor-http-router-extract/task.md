# Extract routing from the request handler into a Router

## Task
`handle` in `src/server.ts` matches `/health`, `/users` and `/users/:id` inline, with the route handlers mixed into the same file. Extract the routing into `src/router.ts`, which exports `type Handler = (params: Record<string, string>) => { status: number; body: string }` and `class Router` with `add(method, pattern, handler)` and `match(method, path)`. `match` returns `{ handler, params }` for a hit, `{ status: 405 }` when some pattern matches the path but none with that method, and `{ status: 404 }` when no pattern matches the path. Move the existing route handler functions with their original bodies into `src/handlers.ts`. `handle` becomes a thin composition: a module-level `Router` with the three routes registered at module load, mapping a `404` or `405` result to the same responses it returns today. Pattern syntax is segment based: `:name` captures one segment as `params.name`, and a trailing `*` segment captures the rest of the path, one or more segments joined with `/`, as `params["*"]`. Add tests for the router in `test/router.test.ts`.

## Scope
- `src/server.ts`
- `src/router.ts`
- `src/handlers.ts`
- `test/router.test.ts`

## Acceptance criteria
- The existing tests in `test/server.test.ts` pass unchanged; status codes, bodies and parameter parsing for every route are identical to today, including an unknown user id answering `404` with `user not found`.
- Trailing slashes behave exactly as before and the existing tests already pin it: `/users/`, `/health/` and `/users/42/` are `404`, not aliases of the route without the slash. A `:name` segment never matches an empty segment.
- `Router.match("GET", "/users/42")` against `/users/:id` returns `params` equal to `{ id: "42" }`.
- A path that matches a pattern registered for a different method returns `{ status: 405 }`; a path that matches no pattern returns `{ status: 404 }`.
- After `add("GET", "/files/*", h)`, `match("GET", "/files/a/b.txt")` returns `params["*"]` equal to `"a/b.txt"`.
- `new Router()` can be constructed on its own, with routes added to it, independently of the router used by `handle`.
- `src/server.ts` contains no string comparison on paths: the source text has no `path ===` and no `startsWith(`.
- `npm run typecheck`, `npm run lint`, and `npm test` pass.
