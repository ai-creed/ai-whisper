// packages/broker/src/control/resume-seed.ts

/**
 * One-shot resume-seed marker (spec §1), stored at workflowContext.resumeSeed by
 * resumeHaltedWorkflow and consumed transactionally by beginPhaseRun. haltReason
 * is captured here because the resume transaction clears workflows.halt_reason —
 * this marker is the only copy that survives to kickoff time.
 */
export interface ResumeSeedMarker {
	phaseIndex: number;
	resumedAt: string;
	haltReason: string | null;
	chainId: string | null;
	message: string | null;
}

/** One prior-attempt handoff, as fed to the digest / final-handback sections. */
export interface SeedRound {
	roundNumber: number;
	step: string | null;
	verdict: string | null;
	handbackText: string | null;
}

// §2a caps. Field caps bound RETAINED SOURCE characters only; truncation
// markers (each ≤ 80 chars) are excluded from field caps and counted in the
// rendered total budget.
export const SEED_TOTAL_BUDGET = 24_000;
export const SEED_HALT_REASON_CAP = 500;
export const SEED_HANDBACK_HEAD_KEEP = 8_000;
export const SEED_HANDBACK_TAIL_KEEP = 4_000;
export const SEED_MESSAGE_CAP = 4_000;
export const SEED_DIGEST_LINE_CAP = 200;

export const SEED_PREAMBLE_HEADER =
	"=== RESUMED PHASE — continuation of a halted attempt ===";

const PREAMBLE_BODY =
	"This phase ran before and was halted; you are continuing it on a fresh chain seeded " +
	"with the prior attempt's context below. Do not restart from scratch — build on what " +
	"the prior attempt already accomplished.";

export function readResumeSeedMarker(
	ctx: Record<string, unknown>,
): ResumeSeedMarker | null {
	const raw = ctx.resumeSeed;
	if (raw === null || raw === undefined || typeof raw !== "object") return null;
	const m = raw as Partial<ResumeSeedMarker>;
	if (typeof m.phaseIndex !== "number" || typeof m.resumedAt !== "string") return null;
	return {
		phaseIndex: m.phaseIndex,
		resumedAt: m.resumedAt,
		haltReason: typeof m.haltReason === "string" ? m.haltReason : null,
		chainId: typeof m.chainId === "string" ? m.chainId : null,
		message: typeof m.message === "string" ? m.message : null,
	};
}

function truncateTail(text: string, keep: number): string {
	if (text.length <= keep) return text;
	return `${text.slice(0, keep)}\n[... ${text.length - keep} characters truncated]`;
}

/** Inline variant for digest lines — no newline before the marker, so each round stays one physical line. */
function truncateLineTail(text: string, keep: number): string {
	if (text.length <= keep) return text;
	return `${text.slice(0, keep)} [... ${text.length - keep} characters truncated]`;
}

function elideMiddle(text: string, headKeep: number, tailKeep: number): string {
	if (text.length <= headKeep + tailKeep) return text;
	const elided = text.length - headKeep - tailKeep;
	const tail = tailKeep > 0 ? text.slice(text.length - tailKeep) : "";
	return `${text.slice(0, headKeep)}\n[... ${elided} characters elided ...]\n${tail}`;
}

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
}

/**
 * Compose the seed text (spec §2/§2a). Sections render only when their source
 * data exists. Deterministic: identical inputs → byte-identical output.
 * Overflow order: drop oldest digest rounds → tighten handback elision
 * (tail first, then head) → truncate message tail.
 */
export function composeResumeSeedText(input: {
	marker: ResumeSeedMarker;
	rounds: SeedRound[];
	commitBase: string | null;
}): string {
	const withHandback = input.rounds.filter((r) => r.handbackText !== null && r.handbackText !== "");
	// One digest entry per ROUND (spec §2): findings→fix continuations share a round
	// number, so group by roundNumber — the round's LATEST handback supplies the line
	// text/step, and the round's latest non-null verdict supplies the verdict.
	const byRound = new Map<number, SeedRound>();
	for (const r of withHandback) {
		const existing = byRound.get(r.roundNumber);
		byRound.set(r.roundNumber, {
			roundNumber: r.roundNumber,
			step: r.step,
			verdict: r.verdict ?? existing?.verdict ?? null,
			handbackText: r.handbackText,
		});
	}
	const perRound = [...byRound.values()]; // rows arrive ascending; Map preserves insertion order
	const final = perRound.length > 0 ? perRound[perRound.length - 1] : null;
	const digestSource = perRound.slice(0, -1);

	let digest = digestSource.map((r) => {
		const line = `round ${r.roundNumber} ${r.step ?? "?"} [${r.verdict ?? "no-verdict"}]: ${firstLine(r.handbackText ?? "")}`;
		return truncateLineTail(line, SEED_DIGEST_LINE_CAP);
	});
	let droppedRounds = 0;
	let headKeep = SEED_HANDBACK_HEAD_KEEP;
	let tailKeep = SEED_HANDBACK_TAIL_KEEP;
	let messageKeep = SEED_MESSAGE_CAP;

	const assemble = (): string => {
		const parts: string[] = [`${SEED_PREAMBLE_HEADER}\n${PREAMBLE_BODY}`];
		if (input.marker.haltReason) {
			parts.push(`Halt reason: ${truncateTail(input.marker.haltReason, SEED_HALT_REASON_CAP)}`);
		}
		if (final) {
			parts.push(
				`--- Final handback from the halted attempt (round ${final.roundNumber}) ---\n` +
					elideMiddle(final.handbackText ?? "", headKeep, tailKeep),
			);
		}
		if (digest.length > 0 || droppedRounds > 0) {
			const note = droppedRounds > 0 ? `(digest truncated: rounds 1–${droppedRounds} omitted)\n` : "";
			parts.push(`--- Prior rounds ---\n${note}${digest.join("\n")}`);
		}
		if (input.marker.message) {
			parts.push(
				`--- Operator message (verbatim) ---\n${truncateTail(input.marker.message, messageKeep)}`,
			);
		}
		if (input.commitBase) {
			parts.push(
				"--- Commit range ---\n" +
					`The authoritative review base for this phase is ${input.commitBase}. ` +
					`The effective commit range is ${input.commitBase}..HEAD — resolve HEAD live; it includes ` +
					"prior-round commits and any commits made while the workflow was halted. " +
					"Ignore any commit hashes quoted in prior handbacks; they describe historical rounds, not the current range.",
			);
		}
		return parts.join("\n\n");
	};

	for (;;) {
		const text = assemble();
		if (text.length <= SEED_TOTAL_BUDGET) return text;
		const over = text.length - SEED_TOTAL_BUDGET;
		if (digest.length > 0) {
			digest = digest.slice(1);
			droppedRounds += 1;
			continue;
		}
		if (tailKeep > 0) {
			tailKeep = Math.max(0, tailKeep - over);
			continue;
		}
		if (headKeep > 0) {
			headKeep = Math.max(0, headKeep - over);
			continue;
		}
		if (messageKeep > 0) {
			messageKeep = Math.max(0, messageKeep - over);
			continue;
		}
		return text; // fixed sections only — bounded by construction
	}
}
