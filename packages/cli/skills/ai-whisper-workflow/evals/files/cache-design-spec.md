# Cache layer design (approved spec)

Goal: add a read-through cache in front of the user-profile store.

Scope: GET /profile/:id only; invalidate on profile write; TTL 5 minutes.
Non-goals: cross-region replication, cache warming.

Acceptance: p95 latency under 40ms on cache hit; stale reads bounded by the
TTL; invalidation verified by an integration test.
