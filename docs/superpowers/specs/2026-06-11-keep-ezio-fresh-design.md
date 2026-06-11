# Keep mounted ezio fresh: co-release CI + runtime staleness guard

**Project:** ai-whisper (with a small trigger change in ai-ezio) · **Date:** 2026-06-11 · **Status:** design (awaiting user review)
**In-repo mirror:** `docs/superpowers/specs/2026-06-11-keep-ezio-fresh-design.md`
(this centralized copy is canonical per the local-docs convention; the repo copy is the committable mirror).
**Related:** `~/.ai-pref-nsync/local-docs/ai-ezio/knowledge-references/2026-06-11-whisper-stale-ezio-bundle.md` (the diagnosis this design responds to).

## Problem

In **mounted mode**, ezio's surface rendering and MCP host run *inside* ai-whisper, not in the standalone `ai-ezio` CLI. ai-whisper esbuild-**inlines** the `@ai-ezio/*` TS packages (`protocol`, `harness`, `surface`, `mcp-host`) into its own `dist` at *its own* build time. Those packages are private `file:` workspace deps (`0.1.0`), never published to npm.

Consequences observed:

- Publishing a new `ai-ezio` release and upgrading the global ezio CLI does **not** change what a mounted collab runs. Only rebuilding ai-whisper and reinstalling its global binary does.
- A machine with both tools installed effectively runs **two independent frozen copies** of ezio's TS layer — one bundled inside `@ai-creed/ai-ezio`, one bundled inside `ai-whisper` — which silently diverge. (Only the native `hax` binary, `@ai-creed/hax-<platform>-<arch>`, is runtime-resolved and therefore shareable.)
- Normal users have no signal explaining the divergence: a fix lands in standalone ezio but the mounted path stays stale with no warning.

The deeper gap: **there is no way, at runtime, to know which ezio a given ai-whisper is actually running.** That invisibility is what let the staleness go unnoticed.

## Goals

1. Make the published `ai-whisper` artifact stay current with ezio **automatically**, so a normal user's `npm i -g ai-whisper@latest` yields an up-to-date mounted ezio (no manual rebuild ritual).
2. Give users a **visible, actionable signal** when their mounted ezio is behind — eliminating the silent-staleness blind spot for the cases automation cannot cover.
3. Make the bundled ezio provenance **introspectable at runtime**.

## Non-goals

- Publishing the `@ai-ezio/*` TS layer as standalone npm packages / fully decoupling whisper from the bundle at runtime. (Considered and rejected for now — it gives up the deliberate "self-contained artifact, zero `@ai-ezio/*` runtime deps" guarantee in `bundle.mjs` and reintroduces version-skew risk. Revisit only if co-release + guard prove insufficient.)
- Solving the separate hax-resolution gap (see Deferred).
- Changing ezio's internal architecture or the `file:` dependency layout.

## Design

Three parts. One shared primitive both mechanisms depend on, plus the two mechanisms themselves.

### Part 1 — ezio provenance stamp (shared primitive, build-time)

At ai-whisper **build time**, capture provenance from the ezio checkout being bundled and emit a generated module that gets inlined into the dist.

- **Producer:** a small `scripts/stamp-ezio-provenance.mjs` invoked from the top of `packages/cli/scripts/bundle.mjs`, **before** `esbuild.build`, so the generated module is inlined into the bundle. Because the stamp is wired *into* the bundle step itself, every `pnpm build` stamps in the correct order automatically — CI and local builds never run the stamp as a separate post-build step.
- **Captured fields:**
  - `ezioCliVersion` — the `@ai-creed/ai-ezio` semver read from the ezio checkout's `packages/cli/package.json` (e.g. `0.2.0-beta.1`). This is the **comparable axis** against an installed standalone CLI. (Note: the internal `@ai-ezio/*` packages live in a *separate* `0.1.0` version space and are **not** usable for comparison.)
  - `ezioGitSha` + ISO build date — exact source provenance.
  - `whisperVersion` — from ai-whisper's own `package.json`.
- **Output:** `packages/cli/src/generated/ezio-provenance.ts` (gitignored; regenerated each build), exporting a typed constant. Read at runtime via a plain ESM import — no filesystem access at runtime.
- **Resolution of the ezio checkout path:** reuse whisper's existing `file:../ai-ezio` layout assumption; the stamp reads `../ai-ezio/packages/cli/package.json` and the ezio repo's git sha. In CI co-release, the workflow pins the exact ezio ref before this runs.

This primitive is the foundation: Part 3 reads it at runtime; Part 2 verifies/records it per release.

### Part 2 — co-release CI (keep the published bundle fresh)

Automate "ezio release ⇒ fresh whisper on npm" so the self-contained bundle is never stale relative to a published ezio.

- **ai-whisper workflow `release-on-ezio.yml`** (mirrors the build contract already proven in `ci.yml` / `publish.yml`):
  1. Checkout ai-whisper and the target ezio ref side-by-side (the `file:../ai-ezio` layout).
  2. **Pre-build the ai-ezio packages first.** In `ai-ezio`: `pnpm install --frozen-lockfile`, then `pnpm --filter "@ai-ezio/harness..." --filter "@ai-ezio/surface..." --filter "@ai-ezio/mcp-host..." build` (mirroring `ci.yml` / `publish.yml` lines 44-48). ai-whisper consumes these as `file:` deps that resolve to their built `dist/index.js` (`packages/adapter-ai-ezio/package.json`), so their `dist` **must exist before** whisper installs or builds — a bare checkout is not enough. This `--filter` list is a **third mirror** of the same list in `ci.yml` and `publish.yml`: any new `@ai-ezio/*` dep must be added to all three workflows (and to `tsconfig.json` paths + `vitest.config.ts` aliases) or the build breaks CI-only.
  3. `pnpm install --frozen-lockfile` in ai-whisper (resolve the freshly-built `file:` ezio deps) → `pnpm build`. The build runs the provenance stamp **before** esbuild (Part 1), so the stamp is inlined automatically — there is **no** separate post-build stamp step.
  4. **Gate on the self-containment smoke** before publishing: `scripts/bundle-selfcontained-smoke.mjs` (`npm pack` → clean-install the tarball in a temp dir with no workspace symlinks → `whisper --version`), exactly as `ci.yml` / `publish.yml` do. A green build/typecheck/test does **not** prove the bundle is self-contained; if a newly-inlined ezio package pulls in a third-party npm dep, it must be declared in `packages/cli/package.json` `dependencies` — the smoke catches that here instead of shipping a broken global install.
  5. Bump ai-whisper's prerelease/patch version, `npm publish`, tag.
- **Trigger — phased (decision locked):**
  - **Phase A (land first): manual `workflow_dispatch`** with an `ezio_ref` input. No cross-repo token required. Operator triggers it after an ezio release. Proves the pipeline end-to-end.
  - **Phase B (follow-up): automatic `repository_dispatch`.** ai-ezio's release workflow fires a `repository_dispatch` (event `ezio-released`, payload = ezio tag + sha) to ai-whisper on publish. Requires a stored token (PAT or GitHub App) with ai-whisper write access — the only real cost, deliberately deferred so auth setup never blocks the core value.
- **Result:** every ezio release that touches mounted behavior auto-produces a fresh whisper. Normal users `npm i -g ai-whisper@latest` and get current mounted ezio. The self-contained artifact and zero-skew guarantees are preserved (whisper is always built against one pinned ezio ref).

### Part 3 — runtime staleness guard (catch what automation can't)

A non-blocking startup check that runs **only when whisper mounts ezio (collab/session start)** — the sole path where ezio staleness matters — so non-ezio whisper usage stays silent. Two user-facing signals, surfaced as dim one-liners, suppressible via `AI_WHISPER_NO_UPDATE_CHECK=1`.

- **Module:** `packages/cli/src/ezio-staleness-check.ts`, invoked from the mounted-session entry path.
- **Signal 1 — whisper is behind (network, cached):**
  - Query the npm registry for the latest published `ai-whisper`. If the installed `whisperVersion` (from the stamp) is older, print: *"ai-whisper X is out of date (latest Y) — run `npm i -g ai-whisper@latest`."*
  - Cached in `~/.ai-whisper/update-check.json` with a ~24h TTL; never blocks startup; any network error → silent skip.
  - Because Part 2 ties "latest whisper" to "latest ezio," this is the **primary** freshness signal for normal users.
- **Signal 2 — standalone ezio is newer than mounted (offline):**
  - Resolve the installed `@ai-creed/ai-ezio` CLI's `package.json` version (best-effort; absent → skip). If it is greater than the stamped `ezioCliVersion`, print: *"Your standalone ezio is X but mounted ezio is Y — update ai-whisper to match."*
  - No network. A proxy comparison (CLI semver ≈ its bundled TS version), accepted as good enough to flag drift.

## Decisions locked

- **TS-layer decoupling:** rejected (non-goal); keep bundling, keep the artifact self-contained.
- **CI trigger:** manual `workflow_dispatch` first (Phase A), automatic `repository_dispatch` as a follow-up (Phase B).
- **Guard timing:** mounted/collab start only.
- **Guard scope:** Signal 1 (whisper-behind) + Signal 2 (standalone-ezio-newer). The dev-drift check (bundle vs local ezio source sha) was *not* selected and is out of scope.

## Implementation phases

This work spans two repos and more than three files, so it decomposes (per the >3-files rule) into ordered, independently-verifiable phases — to be detailed by the writing-plans step:

1. **Provenance stamp** — `stamp-ezio-provenance.mjs`, `bundle.mjs` wiring, generated module, gitignore, build-output test.
2. **Staleness guard** — `ezio-staleness-check.ts` (both signals + cache + suppression), wired into the mounted-session entry, unit tests with injected seams (network, fs, installed-CLI lookup).
3. **Co-release CI Phase A** — `release-on-ezio.yml` with `workflow_dispatch`: pre-build the ai-ezio packages (harness/surface/mcp-host `--filter` list, kept in sync with `ci.yml` / `publish.yml`), then install + `pnpm build` whisper (stamp inlined by the build), gate on `bundle-selfcontained-smoke`, then bump/publish/tag.
4. **Co-release CI Phase B (follow-up)** — `repository_dispatch` auto-trigger in ai-ezio + token setup.

## Deferred / out of scope (separate follow-up)

- **hax resolution for normal users.** The global `ai-whisper` declares no `@ai-creed/hax-*` dependency and ships no `vendor/hax`, so a normal user's mounted hax only resolves via the `AI_EZIO_HAX_BIN` env override (or a separately installed ezio). The developer setup works because the env points at the local ezio build. This is a distinct correctness gap from the staleness problem and is tracked separately, not solved here.

## Edge cases to cover in tests

- Stamp generation when the ezio checkout is missing / `packages/cli/package.json` unreadable → build fails loudly (don't ship an unstamped bundle).
- Guard with no network → Signal 1 silently skips, Signal 2 still runs.
- Guard with no standalone `@ai-creed/ai-ezio` installed → Signal 2 silently skips.
- Guard with a malformed/old cache file → treated as cache-miss, refetched.
- Prerelease semver comparison (`0.2.0-beta.1` vs `0.2.0-beta.2` vs `0.2.0`) is ordered correctly in both signals.
- `AI_WHISPER_NO_UPDATE_CHECK=1` suppresses both signals entirely.
- Stamped `ezioCliVersion` equal to installed standalone → no Signal 2 noise.
- CI co-release builds against a pinned ezio ref reproducibly (same ref ⇒ same stamp).
- CI co-release pre-builds the ai-ezio packages before whisper installs (a missing `dist` ⇒ build fails, not a silent stale inline).

## Verification target

- A freshly built whisper bundle exposes a populated `ezio-provenance` module (non-empty `ezioCliVersion`, `ezioGitSha`).
- Mounting ezio with a deliberately old stamp + a newer installed standalone CLI prints Signal 2; equal versions print nothing.
- `release-on-ezio.yml` (manual) produces a publishable whisper whose stamped `ezioCliVersion` matches the dispatched ezio ref, with the ai-ezio packages pre-built and the `bundle-selfcontained-smoke` gate passing before publish.
