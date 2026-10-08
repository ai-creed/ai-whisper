# Scheduler: dependency graphs, retries and bounded concurrency

## Task
`src/scheduler.ts` exports `class Scheduler` with `add(name, run)` and `runAll()`, which runs jobs one at a time in insertion order and reports `done` or `failed` for each. Turn it into a small dependency-aware scheduler: jobs can declare dependencies, be retried, and run with bounded concurrency. Jobs added without any options must behave exactly as they do today.

**Data model**
- A job has a unique `name`, an async `run`, a list of `deps` (names of other jobs), and a `retries` count (default 0).
- A job ends with one of three statuses: `done`, `failed`, or `skipped`. `skipped` means the job never ran because a dependency did not finish `done`.
- Put the graph logic (cycle detection and any ordering helper you need) in `src/graph.ts` as functions that do not depend on `Scheduler`; `src/scheduler.ts` stays the public entry point.

**Public API**
- `add(name, run, options?)` where `options` is `{ deps?: string[]; retries?: number }`. A job may only depend on jobs that were added before it. The concurrency limit belongs to `runAll`, not to `add`.
- `addDependency(name, dep)` records one more dependency on an already added job. It is the only way to express a dependency on a job added later, and therefore the only way to build a cycle. It throws `unknown job <name>` if `name` is not registered and `unknown dependency <dep>` if `dep` is not.
- `runAll(options?)` takes `{ concurrency?: number }`, defaulting to 1, and resolves to a record from job name to status, with keys in insertion order. Each call to `runAll` runs every registered job afresh.
- Scheduling: a job is ready once all of its deps are `done`. Up to `concurrency` jobs are in flight at once, and whenever a slot is free the next ready job in insertion order is started. With the default concurrency of 1 this is a topological order in which ties go to insertion order. A shared dependency runs once, however many jobs depend on it.
- A job whose dependency ended `failed` or `skipped` becomes `skipped` and its `run` is never called. This propagates transitively.
- Retries: `retries: N` calls `run` again after a failure, up to N extra times (at most N + 1 calls in total). The job is `done` as soon as one call succeeds and `failed` if every call fails. Retries happen immediately, with no delay.

**Error handling**
- `add` throws `duplicate job <name>` for a name that is already registered (existing behaviour) and `unknown dependency <dep>` for the first entry in `deps` that is not yet registered.
- Cycles are detected when `runAll` starts, before any job runs. It rejects with `Error("cycle: a -> b -> a")`: the names along the cycle joined by ` -> `, where each name depends on the next, starting from the earliest-added job on the cycle and ending with that same name again.
- `runAll` rejects with `concurrency must be a positive integer` if `concurrency` is not a positive integer.
- A job's own failure never makes `runAll` reject; it is recorded as `failed`.

**Non-goals**
- Persistence of results between runs.
- Timeouts, cancellation, and delays or backoff between retries.
- Priorities, or per-job concurrency settings.

Add tests for the graph logic in `test/graph.test.ts` and for scheduling behaviour in `test/scheduler.test.ts`. Tests must be deterministic: observe ordering and a max-in-flight counter from injected jobs instead of measuring wall-clock time.

## Scope
- `src/scheduler.ts`
- `src/graph.ts`
- `test/graph.test.ts`
- `test/scheduler.test.ts`

## Acceptance criteria
- Dependencies run before their dependents.
- Independent jobs run concurrently up to the limit: an injected in-flight counter never exceeds `concurrency` and does reach it when enough jobs are ready.
- When a dependency fails, its dependents are `skipped`, transitively, and their `run` is never called.
- `retries: 2` runs a job at most three times and reports `done` if the third call succeeds.
- A cycle makes `runAll` reject with an error naming the cycle path, such as `cycle: a -> b -> a`.
- An unknown dependency at `add` throws `unknown dependency x`.
- A diamond graph runs the shared root exactly once.
- An empty scheduler resolves `{}`.
- Jobs without options behave exactly as before, and the existing tests keep passing unchanged.
- `npm run typecheck`, `npm run lint`, and `npm test` pass.
