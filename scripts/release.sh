#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
	echo "Usage: pnpm release <version>"
	echo "Example: pnpm release 0.16.0"
	exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
	echo "Error: version must be semver (X.Y.Z or X.Y.Z-prerelease), got '$VERSION'"
	exit 1
fi

TAG="v$VERSION"

# Must be on master
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "master" ]]; then
	echo "Error: must be on master branch (currently on '$BRANCH')"
	exit 1
fi

# Working tree must be clean
if [[ -n $(git status --porcelain) ]]; then
	echo "Error: working tree is not clean"
	git status --short
	exit 1
fi

# Tag must not already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
	echo "Error: tag $TAG already exists"
	exit 1
fi

# CHANGELOG.md must already carry this release's entry, so it lands in (or
# before) the tagged release commit — the gate scripts never write it for you.
if ! grep -q "^## \[$VERSION\]" CHANGELOG.md; then
	echo "Error: CHANGELOG.md has no '## [$VERSION]' entry — add it before releasing"
	exit 1
fi

# ─── Release gate ────────────────────────────────────────────────────────
# Tagging must be impossible unless the full verification suite passes.
# Mirrors ci.yml/publish.yml order. Typecheck must be the ROOT script:
# the root tsc pass covers test/, which per-package typecheck never sees
# (bit the v0.12.1 release — tag had to be moved after Publish failed).
echo "Running release gate..."
# `pnpm format` is intentionally absent: master has pre-existing drift and CI
# does not gate it; add it back once the tree is reformatted.
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
CI=true pnpm test
node scripts/bundle-selfcontained-smoke.mjs

# ─── Now safe to mutate ──────────────────────────────────────────────────
# The published package is packages/cli (npm name "ai-whisper"); its
# package.json version is the source of truth the Publish workflow reads.
echo "Releasing $TAG..."
(cd packages/cli && npm version "$VERSION" --no-git-tag-version)

git add packages/cli/package.json
git commit -m "chore: release $TAG"
git tag "$TAG"
git push && git push origin "$TAG"

echo "Done. $TAG pushed. Publish run: https://github.com/ai-creed/ai-whisper/actions"
