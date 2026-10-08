# LRU cache: per-entry TTL

## Task
`src/lru.ts` exports `LruCache<K, V>`, a fixed-capacity cache that evicts the least recently used entry. Add per-entry time-to-live expiry. The constructor becomes `constructor(capacity: number, options?: { ttlMs?: number; now?: () => number })`, where `ttlMs` is the default TTL and `now` is an injectable clock returning milliseconds. `set(key, value, ttlMs?)` accepts a per-call TTL that overrides the default. Expired entries are invisible to `get`, `has` and `size`; they are purged lazily on access and eagerly on `set` when the cache is at capacity, where an expired entry is evicted before any live least-recently-used entry.

## Scope
- `src/lru.ts`
- `test/lru.test.ts`

## Acceptance criteria
- An entry set with `ttlMs: 100` at time `t` is returned by `get` at `t + 99` and is `undefined` at `t + 100`.
- `has` agrees with `get`: it returns `false` for an expired entry.
- `size` excludes expired entries.
- A per-call `ttlMs` passed to `set` overrides the constructor default.
- With no TTL configured an entry never expires.
- When the cache is full and an expired entry exists, `set` evicts the expired entry rather than the least recently used live entry.
- The injected `now` clock is the only time source the cache logic uses; the module does not call `Date.now()` anywhere (when `now` is omitted, fall back to another clock).
- `npm run typecheck`, `npm run lint`, and `npm test` pass; the existing tests keep passing unchanged.
