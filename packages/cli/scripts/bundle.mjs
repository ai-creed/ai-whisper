#!/usr/bin/env node
// Bundle the CLI into a self-contained, publishable artifact.
//
// The published `ai-whisper` package is a single package, but the source is a
// pnpm monorepo: the CLI imports five private `@ai-whisper/*` workspace
// packages. We bundle those (and all local source) into the dist bins so the
// published package has no `@ai-whisper/*` runtime dependencies. Every other
// bare import (real npm deps: node-pty, better-sqlite3, ink, react, fastify,
// …) is kept external and declared in package.json `dependencies`, so npm
// installs them normally — native modules are never bundled.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

// Clean dist first so the published artifact is deterministic — never carries
// stale output (e.g. .d.ts/.map files left by a prior `tsc` typecheck run).
rmSync(path.join(pkgRoot, "dist"), { recursive: true, force: true });

/**
 * Bundle local source + `@ai-whisper/*` workspace packages; externalize every
 * other bare import (real npm dependencies).
 */
const externalizeNpmDeps = {
	name: "externalize-npm-deps",
	setup(b) {
		b.onResolve({ filter: /.*/ }, (args) => {
			if (args.kind === "entry-point") return undefined;
			const p = args.path;
			if (p.startsWith(".") || path.isAbsolute(p)) return undefined; // local → bundle
			if (p.startsWith("@ai-whisper/")) return undefined; // workspace → bundle
			// ai-ezio TS packages (protocol, harness, …) are pure-TS `file:` deps the
			// ezio adapter pulls in — inline them too so the published artifact is
			// self-contained (they are NOT published to the registry). The hax BINARY
			// package `@ai-ezio/hax-<platform>` is resolved at RUNTIME by resolve-hax
			// via createRequire — never a static import — so it stays external.
			if (p.startsWith("@ai-ezio/") && !p.startsWith("@ai-ezio/hax-"))
				return undefined; // ezio TS → bundle
			return { path: p, external: true }; // npm dependency → external
		});
	},
};

// Standalone entry points. whisper + relay-monitor are package bins;
// broker-daemon + companion-agent are spawned as separate node processes.
const entryPoints = [
	"src/bin/whisper.ts",
	"src/bin/relay-monitor.ts",
	"src/bin/broker-daemon.ts",
	"src/bin/companion-agent.ts",
].map((e) => path.join(pkgRoot, e));

await build({
	entryPoints,
	outdir: path.join(pkgRoot, "dist"),
	outbase: path.join(pkgRoot, "src"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	jsx: "automatic",
	jsxImportSource: "react",
	plugins: [externalizeNpmDeps],
	logLevel: "info",
});

console.log(
	"bundle: wrote dist/bin/{whisper,relay-monitor,broker-daemon,companion-agent}.js",
);
