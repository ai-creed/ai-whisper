import { randomUUID } from "node:crypto";
import type { AgentType } from "@ai-whisper/shared";
import type Database from "better-sqlite3";
import { getCollab } from "../storage/repositories/collab-repository.js";
import { listSessionBindingsForCollab } from "../storage/repositories/session-binding-repository.js";
import {
	insertWorkflow,
	getWorkflowById,
	listWorkflows as listWorkflowsRepo,
	countActiveWorkflowsForCollab,
	updateWorkflowContext,
	setWorkflowStatus,
	incrementCurrentPhaseIndex,
	type WorkflowRecord,
	type WorkflowStatus,
} from "../storage/repositories/workflow-repository.js";
import {
	insertWorkflowPhaseRun,
	listPhaseRunsForWorkflow,
	hasOpenPhaseRunForIndex,
	closeWorkflowPhaseRun,
	type WorkflowPhaseRunRecord,
} from "../storage/repositories/workflow-phase-repository.js";
import {
	insertRelayChain,
	getRelayChain as getRelayChainRepo,
	setChainTerminal,
	incrementChainRound,
	type RelayChainRecord,
} from "../storage/repositories/relay-chain-repository.js";
import {
	insertWorkflowOwnedRelayHandoff,
	getHandoffWithWorkflowMetaById,
	updateEvaluatorBookkeeping,
	structuredVerdictToLegacy,
	hasInFlightAcceptedHandoffForWorkflow,
	resetStrandedOrchestrationForWorkflow,
	prependToPendingHandoffRequestText,
} from "../storage/repositories/relay-handoff-repository.js";
import { upsertRelayTurnState } from "../storage/repositories/relay-turn-state-repository.js";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
	renderTemplate,
	derivePlanPath,
	ralphRunDir,
	bugfixPaths,
	RALPH_GOAL_COMPLETE_MARKER,
	ralphFinalLineMarker,
	type PhaseConfig,
	type ReviewMode,
	type WorkflowDefinition,
} from "../runtime/workflow-registry.js";
import type {
	BrokerEventBus,
	BrokerEventName,
} from "../runtime/broker-event-bus.js";

export interface WorkflowControlDeps {
	db: Database.Database;
	events: BrokerEventBus;
	/** Captures a workspace snapshot ref for the given workflow, or null when unavailable.
	 *  SYNCHRONOUS by contract — supplied by the broker runtime, which resolves the
	 *  workflow's collab.workspaceRoot and calls captureWorkspaceSnapshotSync(...). */
	captureSnapshotRef?: (workflowId: string) => string | null;
	/** Diffs operator-changed files for the workflow against pauseSnapshotRef; [] when
	 *  unavailable. SYNCHRONOUS so resumeWorkflow stays synchronous. */
	diffChangedFilesSinceSnapshot?: (workflowId: string, sinceRef: string) => string[];
}

const SHA_REGEX = /^[0-9a-f]{7,40}$/;

/**
 * The commit range a reviewer is pointed at. The upper bound is the literal,
 * LIVE `HEAD` — never a frozen head SHA — so commits added during a code-review
 * fix round are always in scope when the reviewer resolves the range against the
 * current repo. Anchored to the real pre-work base (`baseBeforeExecution`).
 * Falls back to `"HEAD"` when no base is known (e.g. no execution yet).
 *
 * This deliberately ignores any stored `commitRange` snapshot: a frozen head went
 * stale across review rounds and made the reviewer check out an old commit.
 */
export function liveReviewCommitRange(ctx: {
	baseBeforeExecution?: string;
	commitRange?: string;
}): string {
	return ctx.baseBeforeExecution ? `${ctx.baseBeforeExecution}..HEAD` : "HEAD";
}

/**
 * Resolve the {planPath} a workflow's plan-writing phase should target.
 *
 * Prefers the `-design.md` → `docs/superpowers/plans/<date>-<slug>.md`
 * convention. When the spec path doesn't fit that convention, fall back to a
 * DISTINCT sibling next to the spec (`<dir>/<stem>.plan.md`). It must never
 * equal specPath — otherwise the kickoff instructs the implementer to write
 * the plan over the spec, which it correctly refuses, halting the workflow.
 */
export function safeDerivePlanPath(specPath: string, createdAt: string): string {
	try {
		return derivePlanPath(specPath, createdAt);
	} catch {
		const slashIdx = specPath.lastIndexOf("/");
		const dir = slashIdx >= 0 ? specPath.slice(0, slashIdx + 1) : "";
		const base = slashIdx >= 0 ? specPath.slice(slashIdx + 1) : specPath;
		const dotIdx = base.lastIndexOf(".");
		const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
		return `${dir}${stem}.plan.md`;
	}
}

/**
 * Compose the one-time resume notice prepended to the next outgoing request when
 * a paused workflow resumes. Returns `null` when there is nothing to say (no
 * changed files and no operator message) → a plain resume with no notice.
 */
export function composeResumeNotice(input: {
	changedFiles: string[];
	message: string | null;
}): string | null {
	const hasFiles = input.changedFiles.length > 0;
	const hasMessage = !!input.message && input.message.trim().length > 0;
	if (!hasFiles && !hasMessage) return null;
	const lines: string[] = [];
	if (hasFiles) {
		lines.push("While paused, the operator modified these files:");
		for (const f of input.changedFiles) lines.push(`  - ${f}`);
		lines.push("Re-read them before continuing.");
	}
	if (hasMessage) lines.push(`Operator note: ${input.message!.trim()}`);
	lines.push(
		"Re-evaluate whether your current direction still holds; correct course before proceeding.",
	);
	return lines.join("\n");
}

export function createWorkflowControl(deps: WorkflowControlDeps) {
	const { db, events } = deps;

	function createWorkflow(input: {
		collabId: string;
		workflowType: string;
		name?: string;
		specPath: string;
		roleBindings: { implementer: AgentType; reviewer: AgentType };
		now: string;
	}): { workflowId: string } {
		const collab = getCollab(db, input.collabId);
		if (!collab) {
			throw new Error(`createWorkflow: unknown collabId ${input.collabId}`);
		}
		if (!collab.orchestratorEnabled) {
			throw new Error(
				"workflow requires orchestrator-enabled collab; enable AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED and restart broker",
			);
		}
		if (!getWorkflowDefinition(input.workflowType)) {
			throw new Error(
				`createWorkflow: unknown workflowType ${input.workflowType}. Available: ${listWorkflowTypes().join(", ")}`,
			);
		}

		const bindings = listSessionBindingsForCollab(db, input.collabId);
		for (const [role, agent] of Object.entries(input.roleBindings)) {
			const binding = bindings.find(
				(b) => b.agentType === agent && b.bindingState === "bound",
			);
			if (!binding) {
				throw new Error(
					`createWorkflow: role ${role} maps to agent ${agent} which is not bound on collab ${input.collabId}`,
				);
			}
		}

		const workflowId = `wf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

		const tx = db.transaction(() => {
			if (countActiveWorkflowsForCollab(db, input.collabId) > 0) {
				const active = listWorkflowsRepo(db, { collabId: input.collabId }).find(
					(w) => w.status === "running" || w.status === "paused",
				);
				throw new Error(
					`another workflow is already active on this collab (${input.collabId})` +
						(active ? `: ${active.workflowId} (${active.status})` : ""),
				);
			}
			insertWorkflow(db, {
				workflowId,
				collabId: input.collabId,
				workflowType: input.workflowType,
				name: input.name ?? null,
				specPath: input.specPath,
				roleBindings: input.roleBindings,
				status: "running",
				currentPhaseIndex: 0,
				workflowContext: {},
				now: input.now,
			});
		});
		// BEGIN IMMEDIATE acquires the write lock before the callback runs, making the
		// countRunningWorkflowsForCollab guard + insertWorkflow atomic against concurrent callers.
		tx.immediate();

		events.emit("workflow.created", { workflowId });
		return { workflowId };
	}

	function getWorkflow(workflowId: string): WorkflowRecord | null {
		return getWorkflowById(db, workflowId);
	}

	function listWorkflows(filter: {
		collabId?: string;
		status?: WorkflowStatus;
	} = {}): WorkflowRecord[] {
		return listWorkflowsRepo(db, filter);
	}

	function getWorkflowPhaseRuns(workflowId: string): WorkflowPhaseRunRecord[] {
		return listPhaseRunsForWorkflow(db, workflowId);
	}

	function getRelayChain(chainId: string): RelayChainRecord | null {
		return getRelayChainRepo(db, chainId);
	}

	function beginPhaseRun(input: {
		workflowId: string;
		phaseIndex: number;
		phaseName: string;
		initialHandoffStep: "review" | "fix" | "implement" | "execute";
		kickoffText: string;
		sender: AgentType;
		target: AgentType;
		maxRounds: number;
		executionBaseHeadSha?: string;
		now: string;
	}): { phaseRunId: string; chainId: string; handoffId: string } {
		if (input.initialHandoffStep === "execute") {
			if (!input.executionBaseHeadSha) {
				throw new Error(
					"beginPhaseRun(execute) requires executionBaseHeadSha",
				);
			}
			if (!SHA_REGEX.test(input.executionBaseHeadSha)) {
				throw new Error(
					`beginPhaseRun(execute): malformed executionBaseHeadSha: ${input.executionBaseHeadSha}`,
				);
			}
		}

		const workflow = getWorkflowById(db, input.workflowId);
		if (!workflow) {
			throw new Error(`beginPhaseRun: unknown workflowId ${input.workflowId}`);
		}
		if (workflow.status !== "running") {
			throw new Error(
				`beginPhaseRun: workflow ${input.workflowId} not running (status=${workflow.status})`,
			);
		}
		const chainId = `relay_ch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const phaseRunId = `wfp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const handoffId = `ho_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

		const tx = db.transaction(() => {
			if (
				hasOpenPhaseRunForIndex(db, {
					workflowId: input.workflowId,
					phaseIndex: input.phaseIndex,
				})
			) {
				throw new Error(
					`beginPhaseRun: open phase run already exists for workflow ${input.workflowId} index ${input.phaseIndex}`,
				);
			}
			insertRelayChain(db, {
				chainId,
				collabId: workflow.collabId,
				maxRounds: input.maxRounds,
				now: input.now,
			});
			insertWorkflowPhaseRun(db, {
				phaseRunId,
				workflowId: input.workflowId,
				phaseIndex: input.phaseIndex,
				phaseName: input.phaseName,
				chainId,
				now: input.now,
			});
			insertWorkflowOwnedRelayHandoff(db, {
				handoffId,
				collabId: workflow.collabId,
				senderAgent: input.sender,
				targetAgent: input.target,
				requestText: input.kickoffText,
				chainId,
				roundNumber: 1,
				maxRounds: input.maxRounds,
				handoffStep: input.initialHandoffStep,
				workflowId: input.workflowId,
				phaseRunId,
				now: input.now,
			});
			if (input.executionBaseHeadSha) {
				updateWorkflowContext(db, {
					workflowId: input.workflowId,
					patch: { baseBeforeExecution: input.executionBaseHeadSha },
					now: input.now,
				});
			}
		});
		tx.immediate();

		const implementer = getAgentForRole(workflow, "implementer");
		const reviewer = getAgentForRole(workflow, "reviewer");

		events.emit("workflow.phase-started", {
			workflowId: input.workflowId,
			phaseIndex: input.phaseIndex,
			phaseName: input.phaseName,
			chainId,
			phaseRunId,
			implementer,
			reviewer,
		});
		events.emit("workflow.round-started", {
			workflowId: input.workflowId,
			chainId,
			phaseRunId,
			roundNumber: 1,
			handoffStep: input.initialHandoffStep,
			sender: input.sender,
			target: input.target,
		});

		return { phaseRunId, chainId, handoffId };
	}

	type NormalizedVerdict =
		| "approve"
		| "findings"
		| "delivered"
		| "execution-pass"
		| "execution-fail"
		| "escalate";

	function normalizeVerdict(input: {
		step: "review" | "fix" | "implement" | "execute";
		verdict: NormalizedVerdict;
		confidence: number;
		currentRound: number;
		maxRounds: number;
		originalReason: string;
	}): { verdict: NormalizedVerdict; reason: string } {
		if (input.confidence < 0.5) {
			return {
				verdict: "escalate",
				reason: `low-confidence: ${input.originalReason}`,
			};
		}
		const allowed = {
			review: ["approve", "findings", "escalate"],
			fix: ["delivered", "escalate"],
			implement: ["delivered", "escalate"],
			execute: ["execution-pass", "execution-fail", "escalate"],
		} as const;
		if (!allowed[input.step].includes(input.verdict as never)) {
			return {
				verdict: "escalate",
				reason: `illegal-step-verdict: ${input.verdict}`,
			};
		}
		if (
			input.step === "review" &&
			input.verdict === "findings" &&
			input.currentRound + 1 > input.maxRounds
		) {
			return {
				verdict: "escalate",
				reason: `max-rounds-reached (${input.currentRound}/${input.maxRounds})`,
			};
		}
		return { verdict: input.verdict, reason: input.originalReason };
	}

	function getAgentForRole(
		workflow: WorkflowRecord,
		role: "implementer" | "reviewer",
	): AgentType {
		const v = workflow.roleBindings[role];
		if (!v) throw new Error(`getAgentForRole: no binding for ${role}`);
		return v;
	}

	// safeDerivePlanPath is module-level (exported, unit-tested) — the closure
	// calls below resolve to it.

	function renderReviewRequestText(input: {
		workflow: WorkflowRecord;
		phase: PhaseConfig;
	}): string {
		const ctx = input.workflow.workflowContext as {
			commitRange?: string;
			baseBeforeExecution?: string;
			ralphCompletionClaim?: boolean;
		};
		const useAcceptance =
			input.phase.repeatUntilComplete === true &&
			ctx.ralphCompletionClaim === true &&
			input.phase.acceptanceReviewTemplate !== undefined;
		const tmpl = useAcceptance
			? input.phase.acceptanceReviewTemplate!
			: (input.phase.stepTemplates.review ?? "Review the deliverable.");
		const collab = getCollab(db, input.workflow.collabId);
		const ralphDir = collab ? ralphRunDir(collab.workspaceRoot, input.workflow.workflowId) : "";
		const reviewMode: ReviewMode = useAcceptance
			? "acceptance-review"
			: (input.phase.reviewMode ?? "phase-review");
		const bf = collab
			? bugfixPaths(collab.workspaceRoot, input.workflow.workflowId)
			: { bugfixDir: "", diagnosisPath: "", postmortemPath: "" };
		return renderTemplate(tmpl, {
			specPath: input.workflow.specPath,
			planPath: safeDerivePlanPath(
				input.workflow.specPath,
				input.workflow.createdAt,
			),
			commitRange: liveReviewCommitRange(ctx),
			ralphDir,
			reviewMode,
			bugfixDir: bf.bugfixDir,
			diagnosisPath: bf.diagnosisPath,
			postmortemPath: bf.postmortemPath,
		});
	}

	/**
	 * Reads and atomically clears the one-time resume notice for a workflow.
	 * Returns the notice (to prepend to the next outgoing request) or null.
	 */
	function consumeResumeNotice(input: { workflowId: string; now: string }): string | null {
		const wf = getWorkflowById(db, input.workflowId);
		const notice =
			(wf?.workflowContext as { resumeNotice?: string | null })?.resumeNotice ?? null;
		if (notice) {
			updateWorkflowContext(db, {
				workflowId: input.workflowId,
				patch: { resumeNotice: null },
				now: input.now,
			});
		}
		return notice;
	}

	/** Prepend a pending resume notice to an outgoing request text, consuming it once. */
	function withResumeNotice(workflowId: string, requestText: string, now: string): string {
		const notice = consumeResumeNotice({ workflowId, now });
		return notice ? `${notice}\n\n${requestText}` : requestText;
	}

	function createContinuationHandoff(input: {
		workflow: WorkflowRecord;
		chain: RelayChainRecord;
		prev: NonNullable<ReturnType<typeof getHandoffWithWorkflowMetaById>>;
		nextStep: "review" | "fix";
		sender: AgentType;
		target: AgentType;
		requestText: string;
		incrementRound: boolean;
		now: string;
	}): string {
		const handoffId = `ho_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		insertWorkflowOwnedRelayHandoff(db, {
			handoffId,
			collabId: input.workflow.collabId,
			senderAgent: input.sender,
			targetAgent: input.target,
			// Prepend the one-time resume notice (if any) to the FIRST outgoing request
			// after a resume, then it is cleared — so the agent re-reads changed files.
			requestText: withResumeNotice(input.workflow.workflowId, input.requestText, input.now),
			chainId: input.chain.chainId,
			roundNumber: input.incrementRound
				? input.chain.currentRound + 1
				: input.chain.currentRound,
			maxRounds: input.chain.maxRounds,
			handoffStep: input.nextStep,
			workflowId: input.workflow.workflowId,
			phaseRunId: input.prev.phaseRunId!,
			now: input.now,
		});
		// findings → fix does NOT increment the round; the reviewer is sending back to
		// the implementer within the same review cycle. Only delivered → review increments,
		// marking the start of a new full review round.
		if (input.incrementRound) {
			incrementChainRound(db, {
				chainId: input.chain.chainId,
				now: input.now,
			});
		}
		return handoffId;
	}

	function kickoffNextPhaseInternal(input: {
		workflow: WorkflowRecord;
		definition: WorkflowDefinition;
		workspaceHeadSha: string | undefined;
		now: string;
	}): { phaseRunId: string; chainId: string; handoffId: string; emissions: Array<{ name: BrokerEventName; payload: unknown }> } {
		const phase = input.definition.phases[input.workflow.currentPhaseIndex];
		if (!phase) {
			throw new Error(
				`kickoffNextPhaseInternal: no phase at index ${input.workflow.currentPhaseIndex} for workflow type ${input.definition.type}`,
			);
		}
		const sender =
			phase.initialHandoffStep === "review"
				? getAgentForRole(input.workflow, "implementer")
				: getAgentForRole(input.workflow, "reviewer");
		const target =
			phase.initialHandoffStep === "review"
				? getAgentForRole(input.workflow, "reviewer")
				: getAgentForRole(input.workflow, "implementer");
		const ctx = input.workflow.workflowContext as { commitRange?: string; baseBeforeExecution?: string };
		const collab = getCollab(db, input.workflow.collabId);
		const ralphDir = collab ? ralphRunDir(collab.workspaceRoot, input.workflow.workflowId) : "";
		const bf = collab
			? bugfixPaths(collab.workspaceRoot, input.workflow.workflowId)
			: { bugfixDir: "", diagnosisPath: "", postmortemPath: "" };
		const kickoffText = renderTemplate(phase.kickoffTemplate, {
			specPath: input.workflow.specPath,
			planPath: safeDerivePlanPath(
				input.workflow.specPath,
				input.workflow.createdAt,
			),
			commitRange: liveReviewCommitRange(ctx),
			ralphDir,
			reviewMode: phase.reviewMode ?? "phase-review",
			bugfixDir: bf.bugfixDir,
			diagnosisPath: bf.diagnosisPath,
			postmortemPath: bf.postmortemPath,
		});
		const chainId = `relay_ch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const phaseRunId = `wfp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const handoffId = `ho_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		insertRelayChain(db, {
			chainId,
			collabId: input.workflow.collabId,
			maxRounds: phase.maxRounds,
			now: input.now,
		});
		insertWorkflowPhaseRun(db, {
			phaseRunId,
			workflowId: input.workflow.workflowId,
			phaseIndex: input.workflow.currentPhaseIndex,
			phaseName: phase.name,
			chainId,
			now: input.now,
		});
		insertWorkflowOwnedRelayHandoff(db, {
			handoffId,
			collabId: input.workflow.collabId,
			senderAgent: sender,
			targetAgent: target,
			// Prepend a pending resume notice (consumed once) so a phase-advance kickoff
			// after a resume also carries the operator's change notice.
			requestText: withResumeNotice(input.workflow.workflowId, kickoffText, input.now),
			chainId,
			roundNumber: 1,
			maxRounds: phase.maxRounds,
			handoffStep: phase.initialHandoffStep,
			workflowId: input.workflow.workflowId,
			phaseRunId,
			now: input.now,
		});
		if (phase.initialHandoffStep === "execute") {
			if (!input.workspaceHeadSha) {
				throw new Error(
					"kickoffNextPhaseInternal: workspaceHeadSha required for execute phase",
				);
			}
			updateWorkflowContext(db, {
				workflowId: input.workflow.workflowId,
				patch: { baseBeforeExecution: input.workspaceHeadSha },
				now: input.now,
			});
		}
		const emissions: Array<{ name: BrokerEventName; payload: unknown }> = [
			{
				name: "workflow.phase-started",
				payload: {
					workflowId: input.workflow.workflowId,
					phaseIndex: input.workflow.currentPhaseIndex,
					phaseName: phase.name,
					chainId,
					phaseRunId,
					implementer: getAgentForRole(input.workflow, "implementer"),
					reviewer: getAgentForRole(input.workflow, "reviewer"),
				},
			},
			{
				name: "workflow.round-started",
				payload: {
					workflowId: input.workflow.workflowId,
					chainId,
					phaseRunId,
					roundNumber: 1,
					handoffStep: phase.initialHandoffStep,
					sender,
					target,
				},
			},
		];
		return { phaseRunId, chainId, handoffId, emissions };
	}

	function applyOrchestratorVerdict(input: {
		handoffId: string;
		verdict: NormalizedVerdict;
		confidence: number;
		reason: string;
		followUpMessage?: string;
		extractedCommitShas?: string[];
		workspaceHeadSha?: string;
		now: string;
	}): {
		action:
			| "chain-continued"
			| "phase-advanced"
			| "workflow-done"
			| "workflow-halted"
			| "noop-already-applied";
		chainId: string;
		nextHandoffId?: string;
		nextPhaseRunId?: string;
	} {
		const handoff = getHandoffWithWorkflowMetaById(db, input.handoffId);
		if (!handoff || !handoff.workflowId || !handoff.handoffStep || !handoff.phaseRunId) {
			throw new Error(
				"applyOrchestratorVerdict: handoff is not workflow-owned",
			);
		}
		if (handoff.evaluatorVerdict) {
			return {
				action: "noop-already-applied",
				chainId: handoff.chainId ?? "",
			};
		}
		const workflow = getWorkflowById(db, handoff.workflowId);
		if (!workflow || workflow.status !== "running") {
			throw new Error("applyOrchestratorVerdict: workflow not running");
		}
		const chain = getRelayChainRepo(db, handoff.chainId!);
		if (!chain || chain.status !== "active") {
			throw new Error("applyOrchestratorVerdict: chain not active");
		}

		const definition = getWorkflowDefinition(workflow.workflowType)!;
		const phase = definition.phases[workflow.currentPhaseIndex];
		if (!phase) {
			throw new Error(
				`applyOrchestratorVerdict: no phase at index ${workflow.currentPhaseIndex} for workflow type ${workflow.workflowType}`,
			);
		}
		const nextPhase = definition.phases[workflow.currentPhaseIndex + 1];

		const normalized = normalizeVerdict({
			step: handoff.handoffStep,
			verdict: input.verdict,
			confidence: input.confidence,
			currentRound: chain.currentRound,
			maxRounds: chain.maxRounds,
			originalReason: input.reason,
		});

		// Enforce workspaceHeadSha for advance-into-execute
		if (
			normalized.verdict === "approve" &&
			handoff.handoffStep === "review" &&
			nextPhase?.initialHandoffStep === "execute" &&
			(!input.workspaceHeadSha || !SHA_REGEX.test(input.workspaceHeadSha))
		) {
			throw new Error(
				"applyOrchestratorVerdict: workspaceHeadSha required for advance into plan-execution",
			);
		}

		let action:
			| "chain-continued"
			| "phase-advanced"
			| "workflow-done"
			| "workflow-halted"
			| "noop-already-applied" = "chain-continued";
		let nextHandoffId: string | undefined;
		let nextPhaseRunId: string | undefined;

		const pendingEmissions: Array<{
			name: BrokerEventName;
			payload: unknown;
		}> = [];

		const tx = db.transaction(() => {
			// Authoritative idempotency guard: re-read the verdict inside the write
			// lock so a concurrent caller that slipped past the fast-path check above
			// cannot apply the verdict twice.
			const currentVerdict = db
				.prepare("SELECT evaluator_verdict FROM relay_handoff WHERE handoff_id = ?")
				.get(input.handoffId) as { evaluator_verdict: string | null } | undefined;
			if (currentVerdict?.evaluator_verdict) {
				action = "noop-already-applied";
				return;
			}

			updateEvaluatorBookkeeping(db, {
				handoffId: input.handoffId,
				evaluatorVerdict: normalized.verdict,
				evaluatorConfidence: input.confidence,
				evaluatorReason: normalized.reason,
				evaluatorEvaluatedAt: input.now,
				legacyVerdict: structuredVerdictToLegacy(normalized.verdict),
			});

			if (
				normalized.verdict === "approve" ||
				normalized.verdict === "execution-pass"
			) {
				setChainTerminal(db, {
					chainId: chain.chainId,
					status: "done",
					terminalHandoffId: input.handoffId,
					terminalReason: normalized.reason,
					now: input.now,
				});
				closeWorkflowPhaseRun(db, {
					phaseRunId: handoff.phaseRunId!,
					outcome: "done",
					now: input.now,
				});

				if (normalized.verdict === "execution-pass") {
					const shas = (input.extractedCommitShas ?? []).filter((s) =>
						SHA_REGEX.test(s),
					);
					if (shas.length > 0) {
						const base =
							(
								workflow.workflowContext as {
									baseBeforeExecution?: string;
								}
							).baseBeforeExecution ?? "";
						const head = shas[shas.length - 1];
						updateWorkflowContext(db, {
							workflowId: workflow.workflowId,
							patch: {
								executionCommitShas: shas,
								headAfterExecution: head,
								commitRange: `${base}..${head}`,
							},
							now: input.now,
						});
					}
				}

				if (phase.repeatUntilComplete) {
					// Ralph single looping phase: a review-step approve does NOT mark
					// the workflow done the way SDD's final-phase approve does. The
					// completion claim (persisted on the `delivered` verdict from the
					// implementer's GOAL-COMPLETE marker) decides loop-vs-complete.
					// Each arm only sets state + `action` and FALLS THROUGH to the
					// shared emission block — never `return` (that would commit DB
					// state but skip terminal-event emission).
					const rctx = workflow.workflowContext as {
						ralphCompletionClaim?: boolean;
						ralphIteration?: number;
					};
					if (rctx.ralphCompletionClaim === true) {
						setWorkflowStatus(db, {
							workflowId: workflow.workflowId,
							status: "done",
							haltReason: null,
							now: input.now,
						});
						upsertRelayTurnState(db, {
							collabId: workflow.collabId,
							turnOwner: "none",
							waitingAgent: null,
							unresolvedHandoffId: null,
							handoffState: "idle",
							updatedAt: input.now,
							orchestratorEnabled: true,
							currentRound: chain.currentRound,
							maxRounds: chain.maxRounds,
							chainStatus: "done",
						});
						action = "workflow-done";
					} else {
						const iteration = (rctx.ralphIteration ?? 0) + 1;
						// Cap is exclusive: iterations 1..maxIterations-1 loop; reaching maxIterations halts.
						if (iteration >= phase.maxIterations!) {
							setWorkflowStatus(db, {
								workflowId: workflow.workflowId,
								status: "halted",
								haltReason: `ralph loop hit maxIterations cap (${phase.maxIterations}) without completion`,
								now: input.now,
							});
							upsertRelayTurnState(db, {
								collabId: workflow.collabId,
								turnOwner: "none",
								waitingAgent: null,
								unresolvedHandoffId: null,
								handoffState: "idle",
								updatedAt: input.now,
								orchestratorEnabled: true,
								currentRound: chain.currentRound,
								maxRounds: chain.maxRounds,
								chainStatus: "escalated",
							});
							action = "workflow-halted";
						} else {
							updateWorkflowContext(db, {
								workflowId: workflow.workflowId,
								patch: { ralphIteration: iteration },
								now: input.now,
							});
							// currentPhaseIndex is never incremented → re-kicks the
							// SAME phase with a fresh chain/run/implement handoff.
							const kickoff = kickoffNextPhaseInternal({
								workflow: getWorkflowById(db, workflow.workflowId)!,
								definition,
								workspaceHeadSha: input.workspaceHeadSha,
								now: input.now,
							});
							nextHandoffId = kickoff.handoffId;
							nextPhaseRunId = kickoff.phaseRunId;
							pendingEmissions.push(...kickoff.emissions);
							action = "phase-advanced";
						}
					}
				} else if (!nextPhase) {
					setWorkflowStatus(db, {
						workflowId: workflow.workflowId,
						status: "done",
						haltReason: null,
						now: input.now,
					});
					upsertRelayTurnState(db, {
						collabId: workflow.collabId,
						turnOwner: "none",
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle",
						updatedAt: input.now,
						orchestratorEnabled: true,
						currentRound: chain.currentRound,
						maxRounds: chain.maxRounds,
						chainStatus: "done",
					});
					action = "workflow-done";
				} else {
					incrementCurrentPhaseIndex(db, {
						workflowId: workflow.workflowId,
						now: input.now,
					});
					const kickoff = kickoffNextPhaseInternal({
						workflow: {
							...workflow,
							currentPhaseIndex: workflow.currentPhaseIndex + 1,
						},
						definition,
						workspaceHeadSha: input.workspaceHeadSha,
						now: input.now,
					});
					nextHandoffId = kickoff.handoffId;
					nextPhaseRunId = kickoff.phaseRunId;
					// Store kickoff emissions for ordered assembly in the emission block below.
					pendingEmissions.push(...kickoff.emissions);
					action = "phase-advanced";
				}
			} else if (normalized.verdict === "findings") {
				const findingsText =
					input.followUpMessage ?? "Address the reviewer's findings.";
				let fixRequestText: string;
				if (
					(phase.repeatUntilComplete || phase.renderFixTemplateOnFindings) &&
					phase.stepTemplates.fix
				) {
					// Phase-specific fix step. For ralph this carries the anti-amnesia
					// instructions (LEARNINGS.md / PROGRESS.md / item marker) rendered
					// with ralphDir; for complex-bug-fixing it carries the bugfix
					// placeholders ({diagnosisPath}/{postmortemPath}/{commitRange}) so a
					// diagnosis loop points at the artifact and a fix loop at the commit
					// range. The reviewer findings are appended. The generic prompt below
					// lacks all of that. SDD sets neither flag, so it falls through.
					const ctx = workflow.workflowContext as { commitRange?: string; baseBeforeExecution?: string };
					const collab = getCollab(db, workflow.collabId);
					const ralphDir = collab
						? ralphRunDir(collab.workspaceRoot, workflow.workflowId)
						: "";
					const bf = collab
						? bugfixPaths(collab.workspaceRoot, workflow.workflowId)
						: { bugfixDir: "", diagnosisPath: "", postmortemPath: "" };
					const fixTmpl = renderTemplate(phase.stepTemplates.fix, {
						specPath: workflow.specPath,
						planPath: safeDerivePlanPath(
							workflow.specPath,
							workflow.createdAt,
						),
						commitRange: liveReviewCommitRange(ctx),
						ralphDir,
						bugfixDir: bf.bugfixDir,
						diagnosisPath: bf.diagnosisPath,
						postmortemPath: bf.postmortemPath,
					});
					fixRequestText = `${fixTmpl}\n\nReviewer findings:\n${findingsText}`;
				} else {
					// Wrap the raw reviewer findings in an imperative directive so
					// the implementer applies them instead of replying with a
					// clarification question (which the orchestrator would
					// correctly, but uselessly, escalate as non-delivery).
					fixRequestText =
						"Apply the following reviewer findings now. This is an autonomous workflow — no human will respond. Make the changes yourself and hand back the corrected deliverable; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.\n\nFindings:\n" +
						findingsText;
				}
				nextHandoffId = createContinuationHandoff({
					workflow,
					chain,
					prev: handoff,
					nextStep: "fix",
					sender: getAgentForRole(workflow, "reviewer"),
					target: getAgentForRole(workflow, "implementer"),
					requestText: fixRequestText,
					incrementRound: false,
					now: input.now,
				});
				action = "chain-continued";
			} else if (normalized.verdict === "delivered") {
				const sender = getAgentForRole(workflow, "implementer");
				const target = getAgentForRole(workflow, "reviewer");

				if (phase.name === "code-review" && handoff.handoffStep === "fix") {
					const shas = (input.extractedCommitShas ?? []).filter((s) =>
						SHA_REGEX.test(s),
					);
					if (shas.length > 0) {
						const ctx = workflow.workflowContext as {
							baseBeforeExecution?: string;
							codeReviewFixShas?: string[];
						};
						const base = ctx.baseBeforeExecution ?? "";
						const head = shas[shas.length - 1];
						updateWorkflowContext(db, {
							workflowId: workflow.workflowId,
							patch: {
								codeReviewFixShas: [
									...(ctx.codeReviewFixShas ?? []),
									...shas,
								],
								headAfterExecution: head,
								commitRange: `${base}..${head}`,
							},
							now: input.now,
						});
					}
				}

				// Ralph looping phase: recompute the completion claim from the
				// EXACT marker in the implementer handback and persist it to
				// workflowContext (Task 7 reads the persisted flag to decide
				// loop-vs-complete). The local patched copy only feeds this
				// handoff's review-prompt selection (acceptance-gate vs per-item).
				let reviewWorkflow = workflow;
				if (phase.repeatUntilComplete) {
					const handback = handoff.handbackText ?? "";
					// Derive the claim from the FINAL non-empty line (spec §5.4/§7),
					// matching the evaluator's routing — a handback that merely quotes
					// the goal marker earlier but ends with the item marker is NOT a
					// completion claim, so it must not trigger the acceptance gate.
					const claim = ralphFinalLineMarker(handback) === RALPH_GOAL_COMPLETE_MARKER;
					updateWorkflowContext(db, {
						workflowId: workflow.workflowId,
						patch: { ralphCompletionClaim: claim },
						now: input.now,
					});
					reviewWorkflow = {
						...workflow,
						workflowContext: {
							...workflow.workflowContext,
							ralphCompletionClaim: claim,
						},
					};
				}

				nextHandoffId = createContinuationHandoff({
					workflow,
					chain,
					prev: handoff,
					nextStep: "review",
					sender,
					target,
					// reviewWorkflow patches only the in-memory context for prompt selection; chain/prev state is the DB record
					requestText: renderReviewRequestText({ workflow: reviewWorkflow, phase }),
					incrementRound: true,
					now: input.now,
				});
				action = "chain-continued";
			} else {
				// escalate OR execution-fail
				setChainTerminal(db, {
					chainId: chain.chainId,
					status: "escalated",
					terminalHandoffId: input.handoffId,
					terminalReason: normalized.reason,
					now: input.now,
				});
				closeWorkflowPhaseRun(db, {
					phaseRunId: handoff.phaseRunId!,
					outcome: "escalated",
					now: input.now,
				});
				setWorkflowStatus(db, {
					workflowId: workflow.workflowId,
					status: "halted",
					haltReason: normalized.reason,
					now: input.now,
				});
				upsertRelayTurnState(db, {
					collabId: workflow.collabId,
					turnOwner: "none",
					waitingAgent: null,
					unresolvedHandoffId: null,
					handoffState: "idle",
					updatedAt: input.now,
					orchestratorEnabled: true,
					currentRound: chain.currentRound,
					maxRounds: chain.maxRounds,
					chainStatus: "escalated",
				});
				action = "workflow-halted";
			}

			// Buffer event sequence inside tx; drain after commit.
			if (action === "chain-continued") {
				pendingEmissions.push({
					name: "workflow.round-started",
					payload: {
						workflowId: workflow.workflowId,
						chainId: chain.chainId,
						phaseRunId: handoff.phaseRunId!,
						roundNumber:
							normalized.verdict === "findings"
								? chain.currentRound
								: chain.currentRound + 1,
						handoffStep:
							normalized.verdict === "findings" ? "fix" : "review",
						sender: getAgentForRole(
							workflow,
							normalized.verdict === "findings"
								? "reviewer"
								: "implementer",
						),
						target: getAgentForRole(
							workflow,
							normalized.verdict === "findings"
								? "implementer"
								: "reviewer",
						),
					},
				});
			} else if (action === "phase-advanced") {
				// Explicit ordering: chain.resolved → workflow.phase-done → workflow.phase-started → workflow.round-started
				// kickoff.emissions (phase-started + round-started) were already pushed into pendingEmissions;
				// extract them and rebuild the sequence so the order is visible in code, not inferred from
				// array-mutation tricks.
				const kickoffEmissions = pendingEmissions.splice(0);
				pendingEmissions.push(
					{
						name: "chain.resolved",
						payload: {
							collabId: workflow.collabId,
							chainId: chain.chainId,
						},
					},
					{
						name: "workflow.phase-done",
						payload: {
							workflowId: workflow.workflowId,
							phaseIndex: workflow.currentPhaseIndex,
							phaseName: phase.name,
						},
					},
					...kickoffEmissions,
				);
			} else if (action === "workflow-done") {
				pendingEmissions.push(
					{
						name: "chain.resolved",
						payload: {
							collabId: workflow.collabId,
							chainId: chain.chainId,
						},
					},
					{
						name: "workflow.phase-done",
						payload: {
							workflowId: workflow.workflowId,
							phaseIndex: workflow.currentPhaseIndex,
							phaseName: phase.name,
						},
					},
					{
						name: "workflow.done",
						payload: { workflowId: workflow.workflowId },
					},
				);
			} else if (action === "workflow-halted") {
				pendingEmissions.push(
					{
						name: "chain.escalated",
						payload: {
							collabId: workflow.collabId,
							chainId: chain.chainId,
							handoffId: input.handoffId,
							reason: normalized.reason,
						},
					},
					{
						name: "workflow.phase-done",
						payload: {
							workflowId: workflow.workflowId,
							phaseIndex: workflow.currentPhaseIndex,
							phaseName: phase.name,
						},
					},
					{
						name: "workflow.halted",
						payload: {
							workflowId: workflow.workflowId,
							reason: normalized.reason,
						},
					},
				);
			}
		});
		tx.immediate();

		// Drain emissions strictly after COMMIT.
		for (const { name, payload } of pendingEmissions) {
			events.emit(name as never, payload as never);
		}

		const result: {
			action: typeof action;
			chainId: string;
			nextHandoffId?: string;
			nextPhaseRunId?: string;
		} = { action, chainId: chain.chainId };
		if (nextHandoffId) result.nextHandoffId = nextHandoffId;
		if (nextPhaseRunId) result.nextPhaseRunId = nextPhaseRunId;
		return result;
	}

	function haltWorkflow(input: {
		workflowId: string;
		reason: string;
		now: string;
	}): void {
		const workflow = getWorkflowById(db, input.workflowId);
		if (!workflow) {
			throw new Error(`haltWorkflow: unknown workflowId ${input.workflowId}`);
		}
		if (workflow.status !== "running") {
			throw new Error(
				`haltWorkflow: workflow ${input.workflowId} is not running (status=${workflow.status})`,
			);
		}

		const tx = db.transaction(() => {
			const current = getWorkflowById(db, input.workflowId);
			if (!current || current.status !== "running") return; // already halted/done, no-op
			setWorkflowStatus(db, {
				workflowId: input.workflowId,
				status: "halted",
				haltReason: input.reason,
				now: input.now,
			});
		});
		tx.immediate();

		events.emit("workflow.halted", {
			workflowId: input.workflowId,
			reason: input.reason,
		});
	}

	/**
	 * Capture the quiesce-boundary snapshot iff the workflow is paused, not yet
	 * snapshotted, and has no in-flight accepted handoff. Synchronous: the ref is
	 * persisted before this returns, so a resume right after the boundary always
	 * sees the captured ref (when git is available).
	 */
	function maybeCaptureQuiesceSnapshot(input: { workflowId: string; now: string }): void {
		const wf = getWorkflowById(db, input.workflowId);
		if (!wf || wf.status !== "paused") return;
		if ((wf.workflowContext as { pauseSnapshotRef?: unknown }).pauseSnapshotRef !== undefined) {
			return; // already captured
		}
		if (hasInFlightAcceptedHandoffForWorkflow(db, input.workflowId)) return; // not at boundary yet
		const ref = deps.captureSnapshotRef ? deps.captureSnapshotRef(input.workflowId) : null;
		updateWorkflowContext(db, {
			workflowId: input.workflowId,
			patch: { pauseSnapshotRef: ref },
			now: input.now,
		});
	}

	function pauseWorkflow(input: { workflowId: string; now: string }): void {
		const workflow = getWorkflowById(db, input.workflowId);
		if (!workflow) {
			throw new Error(`pauseWorkflow: unknown workflowId ${input.workflowId}`);
		}
		if (workflow.status !== "running") {
			throw new Error(
				`pauseWorkflow: workflow ${input.workflowId} is ${workflow.status}, only running workflows can be paused`,
			);
		}

		const tx = db.transaction(() => {
			const current = getWorkflowById(db, input.workflowId);
			if (!current || current.status !== "running") return; // race no-op
			setWorkflowStatus(db, {
				workflowId: input.workflowId,
				status: "paused",
				haltReason: null,
				now: input.now,
			});
			updateWorkflowContext(db, {
				workflowId: input.workflowId,
				patch: { pausedAt: input.now },
				now: input.now,
			});
		});
		tx.immediate();

		events.emit("workflow.paused", { workflowId: input.workflowId });
		// Synchronous boundary snapshot: when no accepted handoff is in flight, the
		// baseline is captured and persisted NOW, before pauseWorkflow returns — so a
		// subsequent resume always sees a non-null ref (when git is available). The
		// in-flight case no-ops here and is captured later at handback (Task 8).
		maybeCaptureQuiesceSnapshot({ workflowId: input.workflowId, now: input.now });
	}

	// Existing halted → running resume, extracted VERBATIM so the legacy path is
	// provably unchanged (regression guard). Only paused resume is new.
	function resumeHaltedWorkflow(workflow: WorkflowRecord, now: string): void {
		const tx = db.transaction(() => {
			const others = listWorkflowsRepo(db, { collabId: workflow.collabId }).filter(
				(w) =>
					w.workflowId !== workflow.workflowId &&
					(w.status === "running" || w.status === "paused"),
			);
			if (others.length > 0) {
				throw new Error(
					`resumeWorkflow: another workflow is already active on collab ${workflow.collabId}`,
				);
			}
			setWorkflowStatus(db, {
				workflowId: workflow.workflowId,
				status: "running",
				haltReason: null,
				now,
			});
		});
		tx.immediate();

		events.emit("workflow.resumed", {
			workflowId: workflow.workflowId,
			phaseIndex: workflow.currentPhaseIndex,
		});
	}

	function resumeWorkflow(input: {
		workflowId: string;
		now: string;
		message?: string;
	}): void {
		const workflow = getWorkflowById(db, input.workflowId);
		if (!workflow) {
			throw new Error(`resumeWorkflow: unknown workflowId ${input.workflowId}`);
		}
		if (workflow.status === "halted") {
			resumeHaltedWorkflow(workflow, input.now); // unchanged path
			return;
		}
		if (workflow.status !== "paused") {
			throw new Error(
				`resumeWorkflow: workflow ${input.workflowId} is ${workflow.status}, only paused or halted workflows can be resumed`,
			);
		}

		// ── paused → running ──────────────────────────────────────────────────
		// Diff the workspace against the quiesce-boundary baseline; because the
		// baseline post-dates the last agent write (§3/§4), every change is the
		// operator's. A null ref (snapshot unavailable, or resumed before quiesce)
		// yields an empty changed-file set → message-only notice.
		const ref =
			(workflow.workflowContext as { pauseSnapshotRef?: string | null })
				.pauseSnapshotRef ?? null;
		const changedFiles =
			ref && deps.diffChangedFilesSinceSnapshot
				? deps.diffChangedFilesSinceSnapshot(input.workflowId, ref)
				: [];
		const notice = composeResumeNotice({
			changedFiles,
			message: input.message ?? null,
		});

		const tx = db.transaction(() => {
			const others = listWorkflowsRepo(db, { collabId: workflow.collabId }).filter(
				(w) =>
					w.workflowId !== input.workflowId &&
					(w.status === "running" || w.status === "paused"),
			);
			if (others.length > 0) {
				throw new Error(
					`resumeWorkflow: another workflow is already active on collab ${workflow.collabId}`,
				);
			}
			// Release any handback the orchestrator claimed but couldn't evaluate because
			// the pause landed mid-evaluation — otherwise it stays orchestrator_status=
			// 'pending' and the pending list (idle-only) never picks it back up on resume.
			resetStrandedOrchestrationForWorkflow(db, input.workflowId);

			// Resume-notice delivery (spec §5): if a handoff is ALREADY pending accept
			// (the mount injects its stored request text raw), bake the notice into that
			// request now and treat the notice as consumed. Otherwise leave it on the
			// context for the next orchestrator-created handoff to consume.
			let bakedIntoPending = false;
			if (notice) {
				bakedIntoPending = prependToPendingHandoffRequestText(db, {
					workflowId: input.workflowId,
					prefix: notice,
					now: input.now,
				});
			}

			setWorkflowStatus(db, {
				workflowId: input.workflowId,
				status: "running",
				haltReason: null,
				now: input.now,
			});
			updateWorkflowContext(db, {
				workflowId: input.workflowId,
				patch: {
					resumeNotice: bakedIntoPending ? null : notice,
					pausedAt: null,
					pauseSnapshotRef: null,
				},
				now: input.now,
			});
		});
		tx.immediate();

		events.emit("workflow.resumed", {
			workflowId: input.workflowId,
			phaseIndex: workflow.currentPhaseIndex,
		});
	}

	function cancelWorkflow(input: { workflowId: string; now: string }): void {
		const workflow = getWorkflowById(db, input.workflowId);
		if (!workflow) {
			throw new Error(`cancelWorkflow: unknown workflowId ${input.workflowId}`);
		}
		if (workflow.status === "canceled") {
			throw new Error(
				`cancelWorkflow: workflow ${input.workflowId} is already canceled`,
			);
		}
		if (workflow.status === "done") {
			throw new Error(
				`cancelWorkflow: workflow ${input.workflowId} is already done and cannot be canceled`,
			);
		}

		const tx = db.transaction(() => {
			const current = getWorkflowById(db, input.workflowId);
			if (!current || current.status === "canceled" || current.status === "done") return; // already terminal

			// Close any open phase runs with outcome "superseded"
			const openPhaseRuns = listPhaseRunsForWorkflow(db, input.workflowId).filter(
				(r) => r.endedAt === null,
			);
			let lastChainRecord: RelayChainRecord | undefined;
			for (const run of openPhaseRuns) {
				// Abandon the chain for this phase run
				const latest = db
					.prepare(
						`SELECT handoff_id FROM relay_handoff
						 WHERE chain_id = ?
						 ORDER BY created_at DESC LIMIT 1`,
					)
					.get(run.chainId) as { handoff_id: string } | undefined;

				const chainRecord = getRelayChainRepo(db, run.chainId) ?? undefined;
				lastChainRecord = chainRecord;

				closeWorkflowPhaseRun(db, {
					phaseRunId: run.phaseRunId,
					outcome: "superseded",
					now: input.now,
				});

				setChainTerminal(db, {
					chainId: run.chainId,
					status: "abandoned",
					terminalHandoffId: latest?.handoff_id ?? null,
					terminalReason: "canceled by operator",
					now: input.now,
				});
			}

			setWorkflowStatus(db, {
				workflowId: input.workflowId,
				status: "canceled",
				haltReason: "canceled by operator",
				now: input.now,
			});

			const collabRow = db
				.prepare("SELECT orchestrator_max_rounds FROM collab WHERE collab_id = ?")
				.get(workflow.collabId) as { orchestrator_max_rounds: number } | undefined;

			upsertRelayTurnState(db, {
				collabId: workflow.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
				orchestratorEnabled: true,
				currentRound: lastChainRecord?.currentRound ?? 1,
				maxRounds: lastChainRecord?.maxRounds ?? collabRow?.orchestrator_max_rounds ?? 3,
				chainStatus: "abandoned",
			});
		});
		tx.immediate();

		events.emit("workflow.canceled", {
			workflowId: input.workflowId,
			reason: "canceled by operator",
		});
	}

	function getHandoffWithWorkflowMeta(handoffId: string) {
		const meta = getHandoffWithWorkflowMetaById(db, handoffId);
		if (!meta) return null;
		// Plumb the phase's configured evaluatorPromptKey through the handoff metadata
		// (spec §5.3) so the orchestrator consumes the configured key rather than
		// re-deriving it. Falls back to null for non-workflow / unconfigured phases,
		// which the orchestrator maps to its handoffStep derivation (SDD unaffected).
		let evaluatorPromptKey: "review-loop" | "execution-gate" | "ralph-loop" | null = null;
		if (meta.workflowId) {
			const wf = getWorkflowById(db, meta.workflowId);
			const def = wf ? getWorkflowDefinition(wf.workflowType) : undefined;
			const phase = def?.phases.find((p) => p.name === meta.phaseName);
			evaluatorPromptKey = phase?.evaluatorPromptKey ?? null;
		}
		return { ...meta, evaluatorPromptKey };
	}

	function getLatestHandoffForPhaseRun(phaseRunId: string): { handoffStep: string } | null {
		const row = db
			.prepare(
				`SELECT handoff_step FROM relay_handoff
				 WHERE phase_run_id = ?
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(phaseRunId) as { handoff_step: string | null } | undefined;
		if (!row || row.handoff_step === null) {
			return null;
		}
		return { handoffStep: row.handoff_step };
	}

	return {
		createWorkflow,
		getWorkflow,
		listWorkflows,
		getWorkflowPhaseRuns,
		getRelayChain,
		beginPhaseRun,
		applyOrchestratorVerdict,
		haltWorkflow,
		pauseWorkflow,
		maybeCaptureQuiesceSnapshot,
		consumeResumeNotice,
		resumeWorkflow,
		cancelWorkflow,
		getHandoffWithWorkflowMeta,
		getLatestHandoffForPhaseRun,
	};
}
