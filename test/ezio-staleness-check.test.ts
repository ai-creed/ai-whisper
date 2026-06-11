import { describe, it, expect, vi } from "vitest";
import {
	runEzioStalenessCheck,
	parseCache,
	type StalenessDeps,
} from "../packages/cli/src/ezio-staleness-check.js";
import type { EzioProvenance } from "../packages/cli/src/ezio-provenance-types.js";

const REAL: EzioProvenance = {
	ezioCliVersion: "0.2.0-beta.1",
	ezioGitSha: "abc1234",
	builtAt: "2026-06-11T00:00:00.000Z",
	whisperVersion: "0.5.5",
};
const NOW = 1_000_000_000_000;
const FRESH = { checkedAt: NOW - 1000 };
const STALE = { checkedAt: NOW - 48 * 60 * 60 * 1000 };

function deps(over: Partial<StalenessDeps> = {}): StalenessDeps & { _printed: string[] } {
	const printed: string[] = [];
	return {
		env: {},
		now: () => NOW,
		provenance: REAL,
		readCache: () => null,
		writeCache: vi.fn(),
		fetchLatestWhisperVersion: vi.fn(async () => null),
		resolveInstalledEzioVersion: () => null,
		print: (line) => printed.push(line),
		...over,
		_printed: printed,
	};
}
const out = (d: { _printed: string[] }): string => d._printed.join("");
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("runEzioStalenessCheck", () => {
	it("AI_WHISPER_NO_UPDATE_CHECK suppresses everything", async () => {
		const d = deps({ env: { AI_WHISPER_NO_UPDATE_CHECK: "1" }, resolveInstalledEzioVersion: () => "9.9.9" });
		await runEzioStalenessCheck(d);
		expect(out(d)).toBe("");
	});

	it("dev/unstamped provenance no-ops", async () => {
		const d = deps({
			provenance: { ezioCliVersion: "0.0.0-dev", ezioGitSha: "dev", builtAt: "", whisperVersion: "0.0.0-dev" },
			resolveInstalledEzioVersion: () => "9.9.9",
		});
		await runEzioStalenessCheck(d);
		expect(out(d)).toBe("");
	});

	it("Signal 2: prints when standalone ezio is newer", async () => {
		const d = deps({ resolveInstalledEzioVersion: () => "0.2.0" });
		await runEzioStalenessCheck(d);
		expect(out(d)).toContain("standalone ezio is 0.2.0");
		expect(out(d)).toContain("mounted ezio is 0.2.0-beta.1");
	});

	it("Signal 2: no noise when equal, skips when absent", async () => {
		const eq = deps({ resolveInstalledEzioVersion: () => "0.2.0-beta.1" });
		await runEzioStalenessCheck(eq);
		expect(out(eq)).toBe("");
		const absent = deps({ resolveInstalledEzioVersion: () => null });
		await runEzioStalenessCheck(absent);
		expect(out(absent)).toBe("");
	});

	it("Signal 1: prints from a fresh cache when whisper is behind", async () => {
		const fetchLatestWhisperVersion = vi.fn(async () => "9.9.9");
		const d = deps({ readCache: () => ({ latest: "0.6.0", ...FRESH }), fetchLatestWhisperVersion });
		await runEzioStalenessCheck(d);
		expect(out(d)).toContain("ai-whisper 0.5.5 is out of date (latest 0.6.0)");
		expect(fetchLatestWhisperVersion).not.toHaveBeenCalled(); // fresh cache → no network
	});

	it("Signal 1: silent when fresh cache shows up-to-date", async () => {
		const d = deps({ readCache: () => ({ latest: "0.5.5", ...FRESH }) });
		await runEzioStalenessCheck(d);
		expect(out(d)).toBe("");
	});

	it("Signal 1: stale/missing cache refreshes in the BACKGROUND, then writes cache + warns when behind", async () => {
		const writeCache = vi.fn();
		const fetchLatestWhisperVersion = vi.fn(async () => "0.6.0");
		const d = deps({ readCache: () => ({ latest: "0.5.5", ...STALE }), writeCache, fetchLatestWhisperVersion });
		await runEzioStalenessCheck(d);
		expect(fetchLatestWhisperVersion).toHaveBeenCalledOnce();
		await flush(); // let the detached background task settle
		expect(writeCache).toHaveBeenCalledWith({ latest: "0.6.0", checkedAt: NOW });
		expect(out(d)).toContain("ai-whisper 0.5.5 is out of date (latest 0.6.0)");
	});

	it("Signal 1: does NOT block startup — resolves before the network fetch settles", async () => {
		let releaseFetch!: (v: string | null) => void;
		const fetchLatestWhisperVersion = vi.fn(
			() => new Promise<string | null>((resolve) => { releaseFetch = resolve; }),
		);
		const writeCache = vi.fn();
		const d = deps({ readCache: () => ({ latest: "0.5.5", ...STALE }), writeCache, fetchLatestWhisperVersion });
		// The call resolves even though the fetch is still pending → mount never waits.
		await runEzioStalenessCheck(d);
		expect(fetchLatestWhisperVersion).toHaveBeenCalledOnce(); // kicked off
		expect(out(d)).toBe(""); // nothing printed yet (fetch unresolved)
		expect(writeCache).not.toHaveBeenCalled();
		// When the network finally settles, the background task warns + caches.
		releaseFetch("0.6.0");
		await flush();
		expect(writeCache).toHaveBeenCalledWith({ latest: "0.6.0", checkedAt: NOW });
		expect(out(d)).toContain("ai-whisper 0.5.5 is out of date (latest 0.6.0)");
	});

	it("Signal 1: missing cache + network error → silent, no cache write, no throw", async () => {
		const writeCache = vi.fn();
		const d = deps({ readCache: () => null, writeCache, fetchLatestWhisperVersion: vi.fn(async () => null) });
		await expect(runEzioStalenessCheck(d)).resolves.toBeUndefined();
		await flush();
		expect(writeCache).not.toHaveBeenCalled();
		expect(out(d)).toBe("");
	});

	it("Signal 1: a MALFORMED cache file is treated as a miss → refetches + rewrites the cache", async () => {
		const writeCache = vi.fn();
		const fetchLatestWhisperVersion = vi.fn(async () => "0.6.0");
		// Drive readCache through the real parseCache on malformed input so the test
		// exercises the actual "malformed → null → refetch" behavior, not a hand-null.
		const readCache = () => parseCache("{ this is not valid json");
		expect(readCache()).toBeNull(); // precondition: malformed parses to a cache miss
		const d = deps({ readCache, writeCache, fetchLatestWhisperVersion });
		await runEzioStalenessCheck(d);
		expect(fetchLatestWhisperVersion).toHaveBeenCalledOnce(); // miss → refetch
		await flush();
		expect(writeCache).toHaveBeenCalledWith({ latest: "0.6.0", checkedAt: NOW }); // refreshed cache written
		expect(out(d)).toContain("ai-whisper 0.5.5 is out of date (latest 0.6.0)"); // and warns when behind
	});
});

describe("parseCache", () => {
	it("returns null for malformed JSON or missing fields", () => {
		expect(parseCache("not json")).toBeNull();
		expect(parseCache(JSON.stringify({ latest: "0.6.0" }))).toBeNull();
		expect(parseCache(JSON.stringify({ checkedAt: 1 }))).toBeNull();
	});
	it("parses a well-formed cache", () => {
		expect(parseCache(JSON.stringify({ latest: "0.6.0", checkedAt: 123 }))).toEqual({ latest: "0.6.0", checkedAt: 123 });
	});
});
