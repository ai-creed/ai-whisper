import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HELPER_BIN_NAME = "clipboard-change-count";

function execFileText(
	command: string,
	args: string[] = [],
	timeoutMs?: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: timeoutMs ?? 0, killSignal: "SIGTERM" },
			(error, stdout) => {
				if (error) {
					reject(error instanceof Error ? error : new Error("helper failed"));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/**
 * Factory for the changeCount reader. Injectable `platform` and `runHelper`
 * make it deterministically testable. Returns a reader that yields the current
 * NSPasteboard changeCount, or `null` when unavailable (non-darwin, helper
 * missing, helper error, or non-numeric output) — the caller then SKIPS the
 * ownership check rather than blocking capture.
 */
export function makeChangeCountReader(deps?: {
	platform?: NodeJS.Platform;
	runHelper?: () => Promise<string>;
	timeoutMs?: number;
}): () => Promise<number | null> {
	const platform = deps?.platform ?? process.platform;
	const runHelper =
		deps?.runHelper ??
		(async () => {
			// Built binary sits next to compiled JS under the package's build dir.
			const here = dirname(fileURLToPath(import.meta.url));
			const bin = join(here, "..", "native", HELPER_BIN_NAME);
			if (!existsSync(bin)) throw new Error("changeCount helper not built");
			return execFileText(bin, [], deps?.timeoutMs);
		});

	return async (): Promise<number | null> => {
		if (platform !== "darwin") return null;
		try {
			const out = (await runHelper()).trim();
			const n = Number.parseInt(out, 10);
			return Number.isFinite(n) && String(n) === out ? n : null;
		} catch {
			return null;
		}
	};
}
