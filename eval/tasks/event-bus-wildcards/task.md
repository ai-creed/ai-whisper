# Event bus: wildcard subscriptions

## Task
`src/bus.ts` exports `EventBus`, an in-process publish/subscribe bus whose subscriptions currently match a topic exactly. Add wildcard subscriptions over dot-separated topics: `*` matches exactly one segment and `**` matches one or more trailing segments, so `order.*` matches `order.created` but not `order.item.added`, while `order.**` matches both. Put the matching rule in a new `src/match.ts` as an exported pure function `matchTopic(pattern: string, topic: string): boolean`. Add `once(topic, handler)`, which subscribes a handler that runs at most one time. Handlers always receive the concrete topic that was emitted, not the pattern. Delivery order is exact subscribers first, then wildcard subscribers in registration order.

## Scope
- `src/bus.ts`
- `src/match.ts`
- `test/bus.test.ts`

## Acceptance criteria
- `*` matches exactly one segment: `order.*` matches `order.created` and does not match `order.item.added` or `order`.
- `**` matches one or more trailing segments: `order.**` matches `order.created` and `order.item.added`, and does not match `order`. It is only special as the last segment of a pattern; elsewhere it is an ordinary literal segment.
- A handler receives `(payload, concreteTopic)`, where `concreteTopic` is the emitted topic.
- For one `emit`, exact subscribers run before wildcard subscribers, regardless of which was registered first.
- `once` runs its handler a single time and unsubscribes automatically, even if the handler throws (the error still propagates out of `emit`).
- `off(topic, handler)` and the function returned by `on` work for wildcard patterns.
- Emitting a topic that nothing matches is a no-op.
- A handler that unsubscribes itself during `emit` does not cause other matching handlers to be skipped.
- `matchTopic` is exported from `src/match.ts` and has no side effects.
- `npm run typecheck`, `npm run lint`, and `npm test` pass; the existing tests keep passing unchanged.
