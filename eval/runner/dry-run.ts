import type { RunOneInput } from "./run-one.ts";

// Stub: Task 19 replaces this with the real dry-run harness.
export const runDryRun = {
	prepareSliceDryRun: (_repoRoot: string): Promise<RunOneInput["dryRun"]> => Promise.resolve(undefined),
	full: (_repoRoot: string): Promise<boolean> => Promise.resolve(false),
};
