// Runtime staleness guard for mounted ezio. Runs once at ezio-mount start. The
// only network call (Signal 1 on a cold/stale cache) runs in a detached, bounded
// (2s) background task — it is never awaited, so startup is never blocked. All IO
// is injectable so every branch is unit-testable.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareSemver } from "./semver-compare.js";
import { EZIO_PROVENANCE } from "./generated/ezio-provenance.js";
import { isDevProvenance, type EzioProvenance } from "./ezio-provenance-types.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const dim = (s: string): string => `\u001b[2m${s}\u001b[0m\n`;

export interface UpdateCache {
	latest: string;
	checkedAt: number;
}

export interface StalenessDeps {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	provenance?: EzioProvenance;
	readCache?: () => UpdateCache | null;
	writeCache?: (cache: UpdateCache) => void;
	fetchLatestWhisperVersion?: () => Promise<string | null>;
	resolveInstalledEzioVersion?: () => string | null;
	print?: (line: string) => void;
}

/** Pure: validate a cache file body. Returns null when malformed. */
export function parseCache(raw: string): UpdateCache | null {
	try {
		const parsed = JSON.parse(raw) as Partial<UpdateCache>;
		if (typeof parsed.latest === "string" && typeof parsed.checkedAt === "number") {
			return { latest: parsed.latest, checkedAt: parsed.checkedAt };
		}
		return null;
	} catch {
		return null;
	}
}

function cacheFile(): string {
	return join(homedir(), ".ai-whisper", "update-check.json");
}

function defaultReadCache(): UpdateCache | null {
	try {
		return parseCache(readFileSync(cacheFile(), "utf8"));
	} catch {
		return null;
	}
}

function defaultWriteCache(cache: UpdateCache): void {
	try {
		mkdirSync(join(homedir(), ".ai-whisper"), { recursive: true });
		writeFileSync(cacheFile(), JSON.stringify(cache), "utf8");
	} catch {
		// best-effort; a failed cache write just means we re-check next time
	}
}

async function defaultFetchLatestWhisperVersion(): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		const res = await fetch("https://registry.npmjs.org/ai-whisper/latest", {
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const body = (await res.json()) as { version?: string };
		return body.version ?? null;
	} catch {
		return null;
	}
}

function defaultResolveInstalledEzioVersion(): string | null {
	try {
		const require = createRequire(import.meta.url);
		// Read package.json directly from the resolution paths. Do NOT use
		// require.resolve("@ai-creed/ai-ezio/package.json"): that package's exports
		// map exposes no ./package.json subpath, so require.resolve throws
		// ERR_PACKAGE_PATH_NOT_EXPORTED (verified) — which would make Signal 2
		// silently never fire. Walking resolve.paths bypasses the exports gate.
		const paths = require.resolve.paths("@ai-creed/ai-ezio") ?? [];
		for (const base of paths) {
			const pkgPath = join(base, "@ai-creed", "ai-ezio", "package.json");
			if (existsSync(pkgPath)) {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
				return pkg.version ?? null;
			}
		}
		return null; // standalone ezio not installed → skip Signal 2
	} catch {
		return null;
	}
}

/**
 * Print up to two dim advisory lines about a stale mounted ezio. The awaited
 * work is all instant (offline Signal 2 + fresh-cache Signal 1); a stale/missing
 * cache triggers a detached, non-awaited background fetch, so this call always
 * resolves immediately and never blocks the mount on the network.
 */
// Intentionally async-by-contract (callers + tests await it) but awaits nothing:
// the network path is detached so startup is never blocked. Hence no `await`.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runEzioStalenessCheck(deps: StalenessDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	if (env.AI_WHISPER_NO_UPDATE_CHECK) return;

	const provenance = deps.provenance ?? EZIO_PROVENANCE;
	if (isDevProvenance(provenance)) return; // unstamped/dev build — nothing to compare

	const now = deps.now ?? Date.now;
	const print = deps.print ?? ((line: string) => void process.stderr.write(line));
	const readCache = deps.readCache ?? defaultReadCache;
	const writeCache = deps.writeCache ?? defaultWriteCache;
	const fetchLatest = deps.fetchLatestWhisperVersion ?? defaultFetchLatestWhisperVersion;
	const resolveEzio = deps.resolveInstalledEzioVersion ?? defaultResolveInstalledEzioVersion;

	// Signal 2 — offline: installed standalone ezio newer than the mounted snapshot.
	try {
		const installed = resolveEzio();
		if (installed && compareSemver(installed, provenance.ezioCliVersion) > 0) {
			print(
				dim(
					`Your standalone ezio is ${installed} but mounted ezio is ${provenance.ezioCliVersion} — update ai-whisper to match (npm i -g ai-whisper@latest).`,
				),
			);
		}
	} catch {
		// best-effort; never block the mount on Signal 2
	}

	// Signal 1 — ai-whisper itself behind the latest published. Fresh cache →
	// compare now (instant). Stale/missing cache → DETACHED background refresh so
	// the mount is never blocked by the network; it warns + caches when it settles.
	const warnIfBehind = (latest: string): void => {
		if (compareSemver(latest, provenance.whisperVersion) > 0) {
			print(
				dim(
					`ai-whisper ${provenance.whisperVersion} is out of date (latest ${latest}) — run npm i -g ai-whisper@latest.`,
				),
			);
		}
	};
	try {
		const cache = readCache();
		if (cache && now() - cache.checkedAt < CACHE_TTL_MS) {
			warnIfBehind(cache.latest); // fresh cache → instant, no network
		} else {
			// NOT awaited: runEzioStalenessCheck resolves immediately so the mount
			// proceeds. The bounded (2s) fetch warns + caches when it settles; any
			// error is swallowed (silent on network failure).
			void (async () => {
				try {
					const latest = await fetchLatest();
					if (latest) {
						writeCache({ latest, checkedAt: now() });
						warnIfBehind(latest);
					}
				} catch {
					// silent — never surface a network failure
				}
			})();
		}
	} catch {
		// never block startup on Signal 1
	}
}
