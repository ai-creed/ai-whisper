import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deliberationRunDir } from "./workflow-registry.js";

// Creates the run's artifact dir and self-contained .gitignore files that ignore
// the .ai-whisper/ subtree — without touching the user's root .gitignore or any
// tracked file. Mirrors ensureBugfixWorkspace exactly. Idempotent.
//
// Why this is required (not optional): the deliberation kickoff/findings templates and the
// docs both promise the run dir "is gitignored". In a user workspace that has
// never run deliberation, nothing ignores .ai-whisper/, so without these writes the
// deliberation artifacts would be committable — breaking that contract.
export function ensureDeliberationWorkspace(
	workspaceRoot: string,
	workflowId: string,
): string {
	const dir = deliberationRunDir(workspaceRoot, workflowId);
	mkdirSync(dir, { recursive: true });
	// Namespace-level ignore — write only if absent (never clobber a user file).
	const ignorePath = join(workspaceRoot, ".ai-whisper", ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n");
	}
	// Guarantee run-state is ignored even when a pre-existing
	// .ai-whisper/.gitignore has content that doesn't cover deliberation/: a self-owned
	// .gitignore inside the deliberation/ dir ignores everything under it regardless of
	// the parent — without editing the user's file.
	const deliberationIgnorePath = join(
		workspaceRoot,
		".ai-whisper",
		"deliberation",
		".gitignore",
	);
	if (!existsSync(deliberationIgnorePath)) {
		writeFileSync(deliberationIgnorePath, "*\n");
	}
	return dir;
}
