// eval/runner/manifest.ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seededShuffle } from "./random.ts";
import { ARMS, manifestSchema, type Arm, type Manifest, type ManifestRun, type Pins } from "./types.ts";

export function runKey(r: { task: string; arm: Arm; trial: number }): string {
	return `${r.task}/${r.arm}/${r.trial}`;
}

export function buildManifest(input: {
	campaignId: string; taskSlugs: string[]; trials: number; seed: number; pins: Pins; sourceStateRoot: string; now: string;
}): Manifest {
	const runs: ManifestRun[] = [];
	for (const task of input.taskSlugs) {
		for (const arm of ARMS) {
			for (let trial = 1; trial <= input.trials; trial++) {
				runs.push({ task, arm, trial, status: "pending", attempts: 0, runDir: null, startedAt: null, endedAt: null });
			}
		}
	}
	return {
		campaignId: input.campaignId, createdAt: input.now, seed: input.seed,
		sourceStateRoot: input.sourceStateRoot, pins: input.pins,
		runs: seededShuffle(runs, input.seed),
	};
}

export function manifestPath(campaignDir: string): string {
	return join(campaignDir, "manifest.json");
}

export function loadManifest(campaignDir: string): Manifest {
	return manifestSchema.parse(JSON.parse(readFileSync(manifestPath(campaignDir), "utf8")));
}

export function saveManifest(campaignDir: string, m: Manifest): void {
	const target = manifestPath(campaignDir);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(manifestSchema.parse(m), null, "\t") + "\n");
	renameSync(tmp, target);
}

function updateRun(m: Manifest, key: string, fn: (r: ManifestRun) => ManifestRun): Manifest {
	let found = false;
	const runs = m.runs.map((r) => {
		if (runKey(r) !== key) return r;
		found = true;
		return fn(r);
	});
	if (!found) throw new Error(`manifest has no run ${key}`);
	return { ...m, runs };
}

export function claimRun(m: Manifest, key: string, now: string, runDir: string): Manifest {
	return updateRun(m, key, (r) => {
		if (r.status === "done" || r.status === "failed") throw new Error(`run ${key} is already ${r.status}`);
		return { ...r, status: "running", attempts: r.attempts + 1, runDir, startedAt: now, endedAt: null };
	});
}

/** Back to pending as if never claimed (attempt refunded): the run was aborted for an operator-side reason, not run. */
export function releaseRun(m: Manifest, key: string): Manifest {
	return updateRun(m, key, (r) => ({ ...r, status: "pending", attempts: Math.max(0, r.attempts - 1), runDir: null, startedAt: null, endedAt: null }));
}

export function completeRun(m: Manifest, key: string, status: "done" | "failed", now: string): Manifest {
	return updateRun(m, key, (r) => ({ ...r, status, endedAt: now }));
}

export function selectSlice(
	m: Manifest,
	filter: { arms?: Arm[]; tasks?: string[]; limit?: number; includeFailed?: boolean },
): ManifestRun[] {
	const out: ManifestRun[] = [];
	for (const r of m.runs) {
		const selectable = r.status === "pending" || r.status === "running" || (filter.includeFailed === true && r.status === "failed");
		if (!selectable) continue;
		if (filter.arms && !filter.arms.includes(r.arm)) continue;
		if (filter.tasks && !filter.tasks.includes(r.task)) continue;
		out.push(r);
		if (filter.limit !== undefined && out.length >= filter.limit) break;
	}
	return out;
}

export function scheduledPerArm(m: Manifest): number {
	return m.runs.filter((r) => r.arm === "A").length;
}

export function summarize(m: Manifest): {
	pending: number; running: number; done: number; failed: number;
	byArm: Record<Arm, { done: number; failed: number; total: number }>;
} {
	const s = { pending: 0, running: 0, done: 0, failed: 0, byArm: { A: { done: 0, failed: 0, total: 0 }, B: { done: 0, failed: 0, total: 0 }, C: { done: 0, failed: 0, total: 0 } } };
	for (const r of m.runs) {
		s[r.status] += 1;
		s.byArm[r.arm].total += 1;
		if (r.status === "done") s.byArm[r.arm].done += 1;
		if (r.status === "failed") s.byArm[r.arm].failed += 1;
	}
	return s;
}
