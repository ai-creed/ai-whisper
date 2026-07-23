#!/usr/bin/env -S node --import tsx
// One-shot recovery import (run-ledger spec §6). Reconstructs workflow history
// recovered from a purged state.db's freelist — a sqlite3 `.recover` output whose
// `lost_and_found` table holds the un-type-tagged records — into the live run
// ledger. All safety and DB logic lives in the tested
// `runRecoveryImportFromPaths`; this wrapper only parses args and prints the JSON
// result. It is intentionally outside every tsconfig/eslint scope (scripts/** is
// ignored): a free-standing operator tool, run with tsx against the built broker.
//
// Usage:
//   pnpm -r build        # build @ai-whisper/broker first
//   node --import tsx scripts/import-recovery.ts --source <recovered.db> [--target <state.db>]
//
// The target defaults to ~/.ai-whisper/state.db. The import refuses to run when a
// live broker daemon owns the target, or when the target is not at the current
// schema version (run the broker once to migrate, then retry) — it never migrates
// the target itself.
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runRecoveryImportFromPaths } from "@ai-whisper/broker";

// Baked 2026-07-23 real-data expectations (spec §6). A recovery source whose
// counts do not match these exactly is rejected before any write.
const EXPECTATIONS = {
	raw: { workflows: 67, phases: 342, chains: 328, handoffs: 1258 },
	distinct: { workflows: 67, phases: 322, chains: 289, handoffs: 1096 },
	closureFloor: { phases: 135, chains: 152, handoffs: 306 },
};

function parseArgs(argv) {
	let source;
	let target = path.join(os.homedir(), ".ai-whisper", "state.db");
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--source") source = argv[++i];
		else if (argv[i] === "--target") target = argv[++i];
	}
	if (!source) {
		console.error(
			"usage: node --import tsx scripts/import-recovery.ts --source <recovered.db> [--target <state.db>]",
		);
		process.exit(2);
	}
	return { source, target };
}

const { source, target } = parseArgs(process.argv.slice(2));
const now = new Date().toISOString();
const result = runRecoveryImportFromPaths(source, target, EXPECTATIONS, now);
console.log(JSON.stringify(result, null, 2));
