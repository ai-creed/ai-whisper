/** Provenance of the @ai-ezio/* TS layer bundled into this ai-whisper build. */
export interface EzioProvenance {
	/** @ai-creed/ai-ezio CLI semver the bundled ezio source corresponds to. */
	ezioCliVersion: string;
	/** Short git sha of the ezio checkout that was bundled. */
	ezioGitSha: string;
	/** ISO timestamp of the build. */
	builtAt: string;
	/** ai-whisper's own version at build time. */
	whisperVersion: string;
}

/** Defensive sentinel — a real build never produces this (the stamp fails loudly instead). */
export const DEV_PROVENANCE: EzioProvenance = {
	ezioCliVersion: "0.0.0-dev",
	ezioGitSha: "dev",
	builtAt: "",
	whisperVersion: "0.0.0-dev",
};

/** True when provenance looks unstamped/placeholder — the guard then no-ops. */
export function isDevProvenance(p: EzioProvenance): boolean {
	return !p.ezioGitSha || p.ezioGitSha === "dev" || p.ezioCliVersion === "0.0.0-dev";
}
