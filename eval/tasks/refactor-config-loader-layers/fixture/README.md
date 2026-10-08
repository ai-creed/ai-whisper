Layered application config: `loadConfig` in `src/config.ts` merges defaults, an optional JSON file text, `APP_*` environment variables and overrides, later layers winning.
Env keys use the `APP_` prefix and `__` for nesting (`APP_DB__PORT` sets `db.port`); values stay strings.
Run `npm run typecheck`, `npm run lint`, `npm test`.
