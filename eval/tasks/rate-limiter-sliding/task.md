# Rate limiter: sliding window

## Task
`src/token-bucket.ts` exports `TokenBucket`, a rate limiter with an injected clock. Add a second limiter, `SlidingWindowLimiter`, in a new `src/sliding-window.ts`, with `constructor({ limit, windowMs, now })`, `tryAcquire(): boolean` and `retryAfterMs(): number`. `retryAfterMs()` returns 0 when a call would succeed right now, otherwise the milliseconds until the oldest recorded timestamp leaves the window. Export both limiters from `src/index.ts` behind a common `Limiter` interface `{ tryAcquire(): boolean; retryAfterMs(): number }`, and give `TokenBucket` the same two methods while keeping `tryRemove`.

## Scope
- `src/sliding-window.ts`
- `src/index.ts`
- `src/token-bucket.ts`
- `test/sliding-window.test.ts`

## Acceptance criteria
- With `limit` 3 and `windowMs` 1000, three acquires at t=0 succeed, a fourth fails, and `retryAfterMs()` is 1000.
- At t=1000 the fourth acquire succeeds: the boundary is inclusive, so a timestamp exactly `windowMs` old has left the window.
- Old timestamps are pruned, so the memory used is bounded by `limit`.
- `TokenBucket.tryAcquire()` behaves exactly like `tryRemove(1)`.
- When a `TokenBucket` is empty, its `retryAfterMs()` is `ceil((1 - tokens) / refillPerSecond * 1000)`, and it is 0 when a token is available.
- Both classes satisfy the exported `Limiter` interface.
- No source file under `src/` calls `Date.now()`.
- `npm run typecheck`, `npm run lint`, and `npm test` pass; the existing tests keep passing unchanged.
