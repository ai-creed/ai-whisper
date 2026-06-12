import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The published `ai-whisper` package.json sits at a different depth from this
// module depending on how it is loaded. In the layouts we ship today both the
// esbuild-bundled binary (this module is inlined into dist/bin/<entry>.js, so
// import.meta.url is dist/bin/ → ../../package.json) and the from-source vitest
// run (packages/cli/src/runtime/ → ../../package.json) resolve via the first
// candidate. `../package.json` is a defensive fallback for any alternate emit
// layout (e.g. a future per-file dist/runtime/ build) where the package root is
// one level up. We try both and key off the package NAME so a parent monorepo
// package.json can never shadow the real one.
const PKG_CANDIDATES = ["../../package.json", "../package.json"] as const;

function readWhisperPackage(): { url: URL; version: string } | null {
	for (const rel of PKG_CANDIDATES) {
		try {
			const url = new URL(rel, import.meta.url);
			const pkg = JSON.parse(readFileSync(url, "utf8")) as {
				name?: string;
				version?: string;
			};
			if (pkg.name === "ai-whisper" && typeof pkg.version === "string") {
				return { url, version: pkg.version };
			}
		} catch {
			// try the next candidate
		}
	}
	return null;
}

export function resolveCliVersion(): string {
	return readWhisperPackage()?.version ?? "0.0.0-dev";
}

export function resolveInstallPath(): string {
	const found = readWhisperPackage();
	// Fall back to this module's own directory if the package.json can't be
	// located — never throw; the env report must succeed in any environment.
	return dirname(
		fileURLToPath(found ? found.url : import.meta.url),
	);
}
