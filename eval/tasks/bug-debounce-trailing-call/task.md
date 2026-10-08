# Debounce: wrong trailing call and flush after cancel

## Task
With `{ leading: true, trailing: true }` in `src/debounce.ts`, calling `d(1); d(2); d(3)` within the wait invokes `fn(1)` immediately and then `fn(1)` again on the trailing edge, but the trailing call is expected to be `fn(3)`. Also, after `d(1)`, calling `d.cancel(); d.flush()` still invokes `fn`, but nothing should be called. Finally, a call made from inside `fn` during the leading invocation is silently lost instead of being queued for the trailing edge. Fix these.

## Scope
- `src/debounce.ts`
- `test/debounce.test.ts`

## Acceptance criteria
- The trailing edge uses the arguments of the latest call.
- With leading and trailing both enabled, a single call invokes `fn` exactly once.
- Calling `cancel()` and then `flush()` is a no-op.
- `flush()` with a pending trailing call invokes `fn` immediately with the latest arguments and clears the timer, so `fn` is not invoked again when the wait elapses.
- A call made from inside `fn` during the leading invocation is queued for the trailing edge.
- The injected `setTimeout` and `clearTimeout` are the timers used; the tests drive them with `vi.useFakeTimers()`.
- The existing tests keep passing unchanged, and `npm run typecheck`, `npm run lint`, and `npm test` pass.
