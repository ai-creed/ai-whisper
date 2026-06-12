import { join } from "node:path";
import type { AgentType } from "@ai-whisper/shared";

export type HandoffStep = "review" | "fix" | "implement" | "execute";

export type ReviewMode = "chunk-review" | "phase-review" | "acceptance-review";

export type ArtifactKind = "spec" | "plan" | "commit-range";

export const RALPH_ITEM_DELIVERED_MARKER = "[[RALPH:ITEM-DELIVERED]]";
export const RALPH_GOAL_COMPLETE_MARKER = "[[RALPH:GOAL-COMPLETE]]";

/**
 * The ralph marker on the handback's final non-empty line, or null when neither
 * marker is the final line. Matches the evaluator contract (spec §5.4/§7): the
 * marker must be on its own final line — a marker quoted earlier with other
 * content after it does NOT count. Used as the authoritative, deterministic
 * completion signal so it never disagrees with the evaluator's routing.
 */
export function ralphFinalLineMarker(
	handback: string,
): typeof RALPH_GOAL_COMPLETE_MARKER | typeof RALPH_ITEM_DELIVERED_MARKER | null {
	const lines = handback.split(/\r?\n/);
	let lastNonEmpty = "";
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i]!.trim();
		if (trimmed.length > 0) {
			lastNonEmpty = trimmed;
			break;
		}
	}
	if (lastNonEmpty === RALPH_GOAL_COMPLETE_MARKER) return RALPH_GOAL_COMPLETE_MARKER;
	if (lastNonEmpty === RALPH_ITEM_DELIVERED_MARKER) return RALPH_ITEM_DELIVERED_MARKER;
	return null;
}

export interface PhaseConfig {
	name: string;
	implementerRole: "implementer";
	reviewerRole: "reviewer" | null;
	maxRounds: number;
	initialHandoffStep: HandoffStep;
	kickoffTemplate: string;
	stepTemplates: Partial<Record<HandoffStep, string>>;
	evaluatorPromptKey: "review-loop" | "execution-gate" | "ralph-loop";
	artifactOut: { kind: ArtifactKind; pathTemplate?: string };
	repeatUntilComplete?: boolean;
	maxIterations?: number;
	/** Review-request template used when the implementer claims the goal is complete. */
	acceptanceReviewTemplate?: string;
	/** Review mode for this phase's normal review step. Acceptance reviews always use "acceptance-review". */
	reviewMode?: ReviewMode;
	/** When true, the driver reads workspace HEAD on entry to this phase and
	 *  anchors it as baseBeforeExecution, even though this is not an `execute`
	 *  phase. Lets a later review-loop phase resolve {commitRange} as base..HEAD.
	 *  Opt-in and additive — leaves SDD/ralph (which never set it) unchanged. */
	anchorCommitBaseOnEntry?: boolean;
	/** When true, a findings→fix loop renders this phase's `stepTemplates.fix`
	 *  (with the bugfix placeholders + appended reviewer findings) instead of the
	 *  generic findings wrapper. Without it, non-ralph fix steps use the generic
	 *  wrapper and the phase's fix template would be dead code. Opt-in and additive
	 *  — SDD/ralph never set it, so their findings→fix behavior is unchanged. */
	renderFixTemplateOnFindings?: boolean;
}

export interface WorkflowDefinition {
	type: string;
	displayName: string;
	description: string;
	phases: PhaseConfig[];
	defaultImplementer?: AgentType;
	defaultReviewer?: AgentType;
}

export const WORKFLOW_REVIEW_PROTOCOL = `--- ai-whisper workflow review protocol ---
You are the gatekeeper for an ai-whisper autonomous workflow review gate (reviewMode: {reviewMode}). No human is in the loop. Follow this protocol before returning a verdict.

Review mode semantics:
- chunk-review: judge ONLY the current delivered chunk against the relevant goal/procedure slice; the whole goal need not be complete.
- phase-review: judge the current phase output against the phase contract and relevant spec/plan requirements; future phases need not be complete.
- acceptance-review: judge the FULL deliverable against the full contract and acceptance criteria.

Required procedure:
1. Build an acceptance matrix and PRINT it. One row per requirement/criterion relevant to this gate: Requirement | Required evidence | Implementation evidence | Test/verification evidence | Pass/Fail. Do not collapse into a broad "looks good". Approval requires every row to pass.
2. Tests are deliverables: if the contract requires a test/guard/fixture/verification, inspect the committed test itself — does it check the exact condition and the correct layer? Would the required regression still slip through while it passes? Watch exactness words (exactly, same, both, after build, no code changes, guard, must). Green output does NOT replace required committed coverage.
3. Adversarial pass: assume the implementation is subtly incomplete; try to make each gate criterion fail. Tie every candidate blocking finding to an exact contract item; if it cannot be tied, do not report it as blocking (record it as a non-blocking risk if it is still useful quality signal).

Severity:
- Blocking ONLY if it prevents THIS gate from validly passing (criteria violation, contract contradiction, required verification failure, required test that does not test the specified condition/layer, forbidden change, or behavior that breaks the spec). Name the exact contract item for every blocking finding.
- Do NOT block on style/naming, optional refactors, extra non-required tests, future-phase concerns, or (in chunk-review) whole-goal incompleteness. Suppress style/taste entirely.

Findings vs escalation — these resolve to DIFFERENT verdicts; choose deliberately:
- A blocking DEFECT you can name and the upstream step can fix (an internal contradiction in the deliverable, a wrong/missing required test, a contract violation) is a FINDING. Put it under "Findings:" so it loops back for a fix. Do NOT say you "cannot proceed" for a defect you can describe — that wrongly HALTS a loop the implementer could resolve. "Cannot approve" (you have findings) is NOT "cannot proceed" (you cannot review).
- ESCALATE (cannot proceed) ONLY when you genuinely cannot review: an input REQUIRED FOR THIS MODE is absent and is not the implementer's to supply, or the request is impossible to satisfy. Then do not approve and do not file a fixable finding; signal that you CANNOT PROCEED so the gate ESCALATES and halts.

Never reply with only a single word or a bare verdict; your full reply (matrix + verdict) must be well over 100 characters.

Output format — the verdict line MUST come before the Non-blocking risks section, which is always LAST:
Review matrix:
| Requirement | Evidence | Test/verification evidence | Result |
| ... |

Findings:           (omit this block entirely if none)
- <blocking finding tied to an exact contract item, with file/line or command evidence>

<verdict line: "Approved. <one or two sentences>" OR, when blocked/cannot-proceed, state you cannot proceed and why>

Non-blocking risks:
- <quality risk that does NOT block this gate, or "None.">
--- end protocol ---`;

export const WORKFLOW_OPERATOR_CONTROL = `--- ai-whisper operator control ---
If the operator interrupts you and asks to pause the workflow (e.g. "pause the workflow, I need to fix X"):
1. Find the active workflow id: run \`whisper workflow list\`.
2. Run \`whisper workflow pause <id>\`.
3. Acknowledge and STOP working — do not start the next change.
The operator will edit artifacts and later run \`whisper workflow resume <id> [--message "..."]\`; you will then receive a notice of what changed and must re-read those files before continuing.
Provider note: the Codex CLI EXITS its session on Ctrl+C at an idle prompt (a mid-task Ctrl+C only interrupts the running task). The operator typically interrupts you while you are BUSY before issuing this instruction; do not assume Ctrl+C is a safe no-op.
--- end operator control ---`;

export const WORKFLOW_DIAGNOSIS_PROTOCOL = `--- ai-whisper diagnosis review protocol ---
You are the gatekeeper for an ai-whisper complex-bug-fixing DIAGNOSIS gate. No human is in the loop. Do NOT trust the implementer's diagnosis — verify it yourself. The gate stays shut until YOU independently agree on the root cause and that the fix is net-safe.

Required procedure:
1. Independently reproduce: re-run the implementer's reproduction yourself; do not trust pasted output. If YOU cannot reproduce it, that is a blocking finding (the repro is not real/reliable). Speculation from reading code paths is not a valid reproduction.
2. Attack the causal claim: is the cause PROVEN by the evidence chain, or merely asserted? Could the named cause be a correlate, or a symptom of something deeper? Demand any missing link.
3. Attack the fix (anti-whack-a-mole): does the proposed fix remove the root cause, or just this symptom's surface? Could the bug resurface through another path? Name it if so.
4. Attack the blast radius: is every affected area/module/contract listed? Add what is missing.
5. Attack residual risks: are the real foreseeable risks named, or hand-waved?
6. Mutual-agreement gate: approve ONLY when you have independently confirmed the reproduction and agree the cause is proven and the fix is net-safe (fixes more than it risks). "Plausible" is not approval.

Severity: a blocking finding must tie to a concrete diagnosis-contract item (unreproducible repro, unproven cause, symptom-masking fix, incomplete blast radius, un-named risk). Suppress style/taste. Do NOT gag valuable non-contract risk signals — surface them under "Non-blocking risks:" (always last) so they reach the human at escalation/completion.

Findings vs escalation: a fixable defect in the diagnosis is a FINDING (loops back for revision) — do NOT say you "cannot proceed" for a defect you can describe. ESCALATE only when you genuinely cannot review (a required reproduction input is absent and is not the implementer's to supply).

Never reply with only a bare verdict; your full reply must be well over 100 characters.

Output format — the verdict line MUST come before the Non-blocking risks section, which is always LAST:
Diagnosis review matrix:
| Claim | Required evidence | Implementer evidence | Independently verified? | Result |
| ... |

Findings:           (omit this block entirely if none)
- <blocking finding tied to an exact diagnosis-contract item, with evidence>

<verdict line: "Approved. <one or two sentences>" OR, when blocked/cannot-proceed, state you cannot proceed and why>

Non-blocking risks:
- <risk that does NOT block this gate, or "None.">
--- end protocol ---`;

// Code-review skill guidance prepended to code-bearing review handoffs only.
// It tells the reviewer to use the ai-whisper-code-review skill for HOW to
// inspect code, while WORKFLOW_REVIEW_PROTOCOL (which follows it) remains
// authoritative for output shape and evaluator semantics. Keep it BEFORE the
// protocol so the verdict-before-`Non-blocking risks:` invariant is untouched.
export const CODE_REVIEW_SKILL_GUIDANCE =
	"Use the ai-whisper-code-review skill to evaluate the delivered code. The workflow review protocol below controls your output format and evaluator semantics; the skill controls how you inspect code and decide which code-quality issues are blocking.\n\n";

// Plan-execution skill guidance appended to the SDD plan-execution handoffs.
// It tells the implementer to use the ai-whisper-plan-execution skill for HOW
// to execute the plan (subagent fan-out + model allocation where the harness
// supports it), while the task statement before it stays authoritative for
// WHAT to deliver and the handback contract. Keep it AFTER the task statement,
// mirroring the SDD_CODE_REVIEW composition order.
export const PLAN_EXECUTION_SKILL_GUIDANCE =
	"Use the ai-whisper-plan-execution skill to structure HOW you execute this plan: subagent fan-out with model allocation where your harness supports it, disciplined inline execution otherwise. The handback contract above remains authoritative — settle all delegated work before handing back, and state which execution mode you used.";

const SDD_SPEC_REVIEW =
	"Review the spec at {specPath}. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_REVIEW_PROTOCOL;

const SDD_CODE_REVIEW =
	"Review the implementer's changes for this phase — the commits in {commitRange}. The upper bound is a LIVE `HEAD`: resolve it against the current repository at review time and INCLUDE any commits added during this review round (e.g. fixes for your prior findings); do not pin the review to an earlier tip. Verify against the spec's acceptance criteria and run the project's verification/tests. This is an autonomous workflow with no human in the loop.\n\n" +
	CODE_REVIEW_SKILL_GUIDANCE +
	WORKFLOW_REVIEW_PROTOCOL;

const SDD_PLAN_EXECUTION =
	"Execute the plan at {planPath} now: make all changes it specifies, run the verification command the plan or spec defines and ensure it passes, then commit. This is an autonomous workflow — no human will respond. Do the work yourself; never ask for confirmation, permission, or clarification. Hand back the commit SHAs and the verification output, plus a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.\n\n" +
	PLAN_EXECUTION_SKILL_GUIDANCE;

export const SPEC_DRIVEN_DEVELOPMENT: WorkflowDefinition = {
	type: "spec-driven-development",
	displayName: "Spec-Driven Development",
	description: "Spec refining → plan writing → execution → code review",
	defaultImplementer: "claude" as const,
	defaultReviewer: "codex" as const,
	phases: [
		{
			name: "spec-refining",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "review",
			kickoffTemplate: SDD_SPEC_REVIEW,
			stepTemplates: {
				review: SDD_SPEC_REVIEW,
				fix: "Apply the reviewer's findings to {specPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected spec; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
			reviewMode: "phase-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "spec", pathTemplate: "{specPath}" },
		},
		{
			name: "plan-writing",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "implement",
			kickoffTemplate:
				"Using the approved spec at {specPath}, write a complete implementation plan to {planPath}, then hand back. This is an autonomous workflow — no human will respond. Do the work yourself now; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you wrote; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			stepTemplates: {
				implement:
					"Using the approved spec at {specPath}, write a complete implementation plan to {planPath}, then hand back. This is an autonomous workflow — no human will respond. Do the work yourself now; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you wrote; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
				review:
					"Review the implementation plan at {planPath} against the spec's acceptance criteria. This is an autonomous workflow with no human in the loop.\n\n" +
					WORKFLOW_REVIEW_PROTOCOL,
				fix: "Apply the reviewer's findings to {planPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected plan; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
			reviewMode: "phase-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "plan", pathTemplate: "{planPath}" },
		},
		{
			name: "plan-execution",
			implementerRole: "implementer",
			reviewerRole: null,
			maxRounds: 1,
			initialHandoffStep: "execute",
			kickoffTemplate: SDD_PLAN_EXECUTION,
			stepTemplates: {
				execute: SDD_PLAN_EXECUTION,
			},
			evaluatorPromptKey: "execution-gate",
			artifactOut: { kind: "commit-range" },
		},
		{
			name: "code-review",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "review",
			kickoffTemplate: SDD_CODE_REVIEW,
			stepTemplates: {
				review: SDD_CODE_REVIEW,
				fix: "Apply the reviewer's findings to commits {commitRange} now (amend or add commits as needed). This is an autonomous workflow — no human will respond. Do the work yourself and hand back the updated commit SHAs and verification output; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
			reviewMode: "acceptance-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "commit-range" },
		},
	],
};

const RALPH_KICKOFF = `You are running an autonomous ralph loop against the goal at {specPath}. No human is in the loop — never ask for confirmation, permission, or clarification; do the work yourself.

Run directory (your durable memory; already created): {ralphDir}
- {ralphDir}/PROGRESS.md — the work ledger (done / in-progress / remaining). Create it if absent. If the goal file contains an explicit checklist, copy it in on this first item.
- {ralphDir}/LEARNINGS.md — generalizable corrections to avoid repeating mistakes. Create it if absent. Re-read it every item.

Each turn:
1. Read the goal ({specPath}), PROGRESS.md, and LEARNINGS.md as ground truth (re-orient from these, not from prior conversation).
2. Pick the next unfinished chunk. Size it as the smallest independently-verifiable unit of real progress (e.g. one file, one endpoint, one bug) — small enough to finish and pass review in a single round; if a chunk fails review twice, split it. Honor any granularity the goal file specifies.
3. Do the work, update PROGRESS.md, and commit your code changes (do NOT commit {ralphDir} — it is gitignored).
4. End your handback with a 1-2 sentence summary, then on its own final line the exact marker [[RALPH:ITEM-DELIVERED]].

If PROGRESS.md and the repo show NO remaining work, do not invent more: end your handback with a 1-2 sentence completion summary, then on its own final line the exact marker [[RALPH:GOAL-COMPLETE]] instead.

Your reply must be at least two sentences, well over 100 characters — never hand back only a single word.`;

const RALPH_FIX = `Apply the reviewer's findings now. This is an autonomous workflow — no human will respond. Make the changes yourself; never ask for confirmation, permission, or clarification.

Also append any GENERALIZABLE lesson from these findings (a mistake likely to recur on other items — "pattern X breaks Y -> do Z") to {ralphDir}/LEARNINGS.md; skip one-off typos. Update PROGRESS.md and commit your code changes (not {ralphDir}).

End your handback with a 1-2 sentence summary, then on its own final line the exact marker [[RALPH:ITEM-DELIVERED]]. Your reply must be at least two sentences, well over 100 characters.`;

const RALPH_ITEM_REVIEW =
	"Review the latest delivered chunk against the goal at {specPath}. This is an autonomous workflow with no human in the loop.\n\n" +
	CODE_REVIEW_SKILL_GUIDANCE +
	WORKFLOW_REVIEW_PROTOCOL;

const RALPH_ACCEPTANCE_REVIEW =
	"The implementer claims the ENTIRE goal at {specPath} is complete. Verify the goal's completion/acceptance criteria against the current repository state. This is an autonomous workflow with no human in the loop.\n\n" +
	CODE_REVIEW_SKILL_GUIDANCE +
	WORKFLOW_REVIEW_PROTOCOL;

export const RALPH_LOOP: WorkflowDefinition = {
	type: "ralph-loop",
	displayName: "Ralph Loop",
	description:
		"Gated self-loop: grind an open-ended goal chunk-by-chunk until a reviewer confirms completion",
	defaultImplementer: "claude" as const,
	defaultReviewer: "codex" as const,
	phases: [
		{
			name: "ralph-iteration",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "implement",
			kickoffTemplate: RALPH_KICKOFF,
			stepTemplates: {
				implement: RALPH_KICKOFF,
				fix: RALPH_FIX,
				review: RALPH_ITEM_REVIEW,
			},
			acceptanceReviewTemplate: RALPH_ACCEPTANCE_REVIEW,
			reviewMode: "chunk-review",
			evaluatorPromptKey: "ralph-loop",
			repeatUntilComplete: true,
			maxIterations: 100,
			artifactOut: { kind: "commit-range" },
		},
	],
};

const BUGFIX_DIAGNOSIS_KICKOFF = `You are the implementer in an autonomous complex-bug-fixing workflow. No human is in the loop — never ask for confirmation, permission, or clarification; do the work yourself.

Read the bug report at {specPath}. A human (dev or QA) already observed this bug, so you must reproduce it too — do NOT theorize from reading code paths.

Write a diagnosis artifact to {diagnosisPath} (create the file) with these sections:
1. Reproduction — an ACTUALLY OBSERVED reproduction you ran yourself. Strongly prefer a failing test (RED) failing for the right reason; commit that test in THIS phase. If the project supports e2e/real-browser (e.g. Playwright), use it. Only if no automated test can capture it, give command/log output WITH an explicit justification.
2. Root cause — the causal chain symptom→cause, each link backed by concrete evidence (stack trace, log line, failing assertion, bisect), not assertion.
3. Proposed fix approach — what changes and WHY that removes the root cause rather than masking the symptom.
4. Blast radius — every area/module/contract the fix could affect.
5. Residual risks — foreseeable risks remaining after the fix.

Commit the RED reproduction test (do NOT commit {bugfixDir}; it is gitignored). End your handback with a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.`;

const BUGFIX_DIAGNOSIS_REVIEW =
	"Review the diagnosis artifact at {diagnosisPath} for the bug reported at {specPath}. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_DIAGNOSIS_PROTOCOL;

const BUGFIX_DIAGNOSIS_FIX =
	"Apply the reviewer's findings to the diagnosis at {diagnosisPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself (re-reproduce if needed) and hand back the corrected diagnosis; never ask for confirmation, permission, or clarification. If you added or changed the RED reproduction test while addressing the findings, COMMIT it in this round (do NOT commit {bugfixDir}; it is gitignored) — the next phase reviews the committed change set, so an uncommitted repro update would be invisible to it. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.";

const BUGFIX_FIX_KICKOFF = `The diagnosis at {diagnosisPath} is APPROVED — treat it as ground truth (re-orient from it, not prior conversation). This is an autonomous workflow — no human will respond; do the work yourself.

1. Implement the fix per the APPROVED approach.
2. Turn the reproduction GREEN — the failing test now passes for the right reason; if the repro was a non-test demonstration, re-run it and show the symptom is gone.
3. Run the project's verification/test command PLUS targeted checks across the declared blast radius, including the full suite, to catch regressions.
4. Commit the fix and any added happy-path/edge-case coverage tests (the RED test was committed in diagnosis). Do NOT commit {bugfixDir} (gitignored).

If you discover the approved cause was WRONG, do NOT silently switch to a different fix — the cause was the agreed premise of this run. Stop and hand back that you CANNOT PROCEED because the approved cause is wrong, explaining what the evidence now shows; do not deliver a fix built on a second, unreviewed theory. This halts the run and returns control to a human, who re-opens the diagnosis (a new run, or a resume after they adjust the report) — the workflow does not loop back to the diagnosis phase on its own. Otherwise, hand back the commit SHAs + verification output + a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters.`;

const BUGFIX_FIX_REVIEW =
	"The implementer claims the fix for the bug at {specPath} is complete — the changes are commits {commitRange}; resolve the upper bound against LIVE HEAD and include fix-round commits. Verify against the APPROVED diagnosis at {diagnosisPath}. Independently re-run the reproduction (it must be GREEN) and the verification suite — do not trust pasted output. Confirm: the root cause is actually removed (not just relocated — anti-whack-a-mole); every declared blast-radius area is regression-free; residual risks are handled or explicitly accepted; and COVERAGE is adequate — every happy path has at least one covering test and edge cases are covered. A case that genuinely cannot be covered must be explicitly noted (not silently passed); thin coverage is a blocking finding. This is an autonomous workflow with no human in the loop.\n\n" +
	CODE_REVIEW_SKILL_GUIDANCE +
	WORKFLOW_REVIEW_PROTOCOL;

const BUGFIX_FIX_FIX =
	"Apply the reviewer's findings to commits {commitRange} now (amend or add commits). This is an autonomous workflow — no human will respond. Do the work yourself and hand back the updated commit SHAs and verification output; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters.";

const BUGFIX_POSTMORTEM_KICKOFF = "Write a post-mortem report to {postmortemPath} (create the file) for the bug fixed in this run. This is an autonomous workflow — no human will respond; do the work yourself. Recap: confirmed root cause; the fix applied; reproduction→GREEN evidence; blast radius touched; coverage gaps explicitly listed (carried from the fix review); residual risks; and lessons learned. Do NOT commit {bugfixDir} (gitignored). End your handback with a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters.";

const BUGFIX_POSTMORTEM_REVIEW =
	"Review the post-mortem report at {postmortemPath}. Confirm it faithfully reflects what actually happened in this run — confirmed cause, the fix, the noted coverage gaps, and residual risks are all present and honest. This is not a rubber stamp; gloss-overs or omissions are findings. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_REVIEW_PROTOCOL;

const BUGFIX_POSTMORTEM_FIX =
	"Apply the reviewer's findings to the post-mortem at {postmortemPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected report; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters.";

export const COMPLEX_BUG_FIXING: WorkflowDefinition = {
	type: "complex-bug-fixing",
	displayName: "Complex Bug Fixing",
	description:
		"Reproduce → adversarially-gated diagnosis → fix & verify → post-mortem, for a reported bug whose root cause is unknown",
	defaultImplementer: "claude" as const,
	defaultReviewer: "codex" as const,
	phases: [
		{
			name: "diagnosis",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "implement",
			kickoffTemplate: BUGFIX_DIAGNOSIS_KICKOFF,
			stepTemplates: {
				implement: BUGFIX_DIAGNOSIS_KICKOFF,
				review: BUGFIX_DIAGNOSIS_REVIEW,
				fix: BUGFIX_DIAGNOSIS_FIX,
			},
			reviewMode: "phase-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "spec", pathTemplate: "{diagnosisPath}" },
			anchorCommitBaseOnEntry: true,
			renderFixTemplateOnFindings: true,
		},
		{
			name: "fix-and-verify",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "implement",
			kickoffTemplate: BUGFIX_FIX_KICKOFF,
			stepTemplates: {
				implement: BUGFIX_FIX_KICKOFF,
				review: BUGFIX_FIX_REVIEW,
				fix: BUGFIX_FIX_FIX,
			},
			reviewMode: "acceptance-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "commit-range" },
			renderFixTemplateOnFindings: true,
		},
		{
			name: "post-mortem",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 3,
			initialHandoffStep: "implement",
			kickoffTemplate: BUGFIX_POSTMORTEM_KICKOFF,
			stepTemplates: {
				implement: BUGFIX_POSTMORTEM_KICKOFF,
				review: BUGFIX_POSTMORTEM_REVIEW,
				fix: BUGFIX_POSTMORTEM_FIX,
			},
			reviewMode: "phase-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "spec", pathTemplate: "{postmortemPath}" },
			renderFixTemplateOnFindings: true,
		},
	],
};

/**
 * Append the operator-control fragment to every phase's kickoff template so the
 * mid-workflow "pause the workflow" guidance rides the handoff prompt the agent
 * already receives at each phase/round start. Done once here (DRY) rather than on
 * each template literal. This is the primary, reliable channel; the bundled
 * kickoff skills carry the same guidance for discoverability (see §6).
 */
function withOperatorControl(def: WorkflowDefinition): WorkflowDefinition {
	return {
		...def,
		phases: def.phases.map((p) => ({
			...p,
			kickoffTemplate: `${p.kickoffTemplate}\n\n${WORKFLOW_OPERATOR_CONTROL}`,
		})),
	};
}

const REGISTRY: Record<string, WorkflowDefinition> = {
	[SPEC_DRIVEN_DEVELOPMENT.type]: withOperatorControl(SPEC_DRIVEN_DEVELOPMENT),
	[RALPH_LOOP.type]: withOperatorControl(RALPH_LOOP),
	[COMPLEX_BUG_FIXING.type]: withOperatorControl(COMPLEX_BUG_FIXING),
};

export function ralphRunDir(workspaceRoot: string, workflowId: string): string {
	return join(workspaceRoot, ".ai-whisper", "ralph", workflowId);
}

export function bugfixRunDir(workspaceRoot: string, workflowId: string): string {
	return join(workspaceRoot, ".ai-whisper", "bugfix", workflowId);
}

export function bugfixPaths(
	workspaceRoot: string,
	workflowId: string,
): { bugfixDir: string; diagnosisPath: string; postmortemPath: string } {
	const bugfixDir = bugfixRunDir(workspaceRoot, workflowId);
	return {
		bugfixDir,
		diagnosisPath: join(bugfixDir, "diagnosis.md"),
		postmortemPath: join(bugfixDir, "postmortem.md"),
	};
}

export function getWorkflowDefinition(
	type: string,
): WorkflowDefinition | undefined {
	return REGISTRY[type];
}

export function listWorkflowTypes(): string[] {
	return Object.keys(REGISTRY);
}

/**
 * Substitute `{key}` placeholders in `template` with `values[key]`.
 * Unknown keys are left literal so callers can layer partial renders.
 * Single-pass: values containing `{key}`-like text are NOT re-rendered.
 */
export function renderTemplate(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match: string, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key)
			? (values[key] ?? match)
			: match,
	);
}

/**
 * Derive a plan file path from a design spec path.
 *
 * Expects `specPath` to end with `-design.md` (optionally prefixed with `YYYY-MM-DD-`).
 * Expects `dateIso` to start with `YYYY-MM-DD`.
 * Throws on inputs that don't match these shapes — callers should sanitize first.
 */
export function derivePlanPath(specPath: string, dateIso: string): string {
	if (!/^\d{4}-\d{2}-\d{2}/.test(dateIso)) {
		throw new Error(
			`derivePlanPath: dateIso must start with YYYY-MM-DD, got "${dateIso}"`,
		);
	}
	const basename = specPath.split("/").pop() ?? "";
	if (!basename.endsWith("-design.md")) {
		throw new Error(
			`derivePlanPath: specPath must end with "-design.md", got "${specPath}"`,
		);
	}
	const withoutExt = basename.replace(/\.md$/, "");
	const slug = withoutExt
		.replace(/-design$/, "")
		.replace(/^\d{4}-\d{2}-\d{2}-/, "");
	const date = dateIso.slice(0, 10);
	return `docs/superpowers/plans/${date}-${slug}.md`;
}
