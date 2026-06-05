import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";
import { getBrokerDaemonByCollab, getWorkflowDefinition } from "@ai-whisper/broker";
import {
	isEvaluatorPreflightBlocked,
	type EvaluatorStatus,
} from "../../runtime/evaluator-config.js";

const EVALUATOR_README_HINT = "See the README \"Evaluator configuration\" section for details.";

export interface WorkflowStartDeps {
	broker: {
		db: Database.Database;
		control: {
			createWorkflow: (input: {
				collabId: string;
				workflowType: string;
				name?: string;
				specPath: string;
				roleBindings: { implementer: AgentType; reviewer: AgentType };
				now: string;
			}) => { workflowId: string };
		};
	};
	collabId: string;
	workflowType: string;
	specPath: string;
	implementer?: AgentType;
	reviewer?: AgentType;
	/** The agent that triggered this run (from AI_WHISPER_AGENT); null when unknown. */
	callerAgent?: AgentType | null;
	name?: string;
	now: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowStart(
	deps: WorkflowStartDeps,
): Promise<{ workflowId: string; roleWarning?: string }> {
	// Preflight: bail early on an unconfigured evaluator so users get an
	// actionable remediation instead of an ~80s mid-run LLM-evaluation halt.
	const daemon = getBrokerDaemonByCollab(deps.broker.db, deps.collabId);
	const evaluatorStatus = (daemon?.evaluatorStatus ?? "unknown") as EvaluatorStatus;
	if (isEvaluatorPreflightBlocked(evaluatorStatus)) {
		if (evaluatorStatus === "missing_anthropic_key") {
			throw new Error(
				"Evaluator is not configured: ANTHROPIC_API_KEY is missing. " +
					"Add it to ~/.ai-whisper/auth.json as { \"ANTHROPIC_API_KEY\": \"sk-ant-...\" } " +
					"(mode 600), then restart the daemon: whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		} else {
			// invalid_config
			throw new Error(
				"Evaluator configuration is invalid: ~/.ai-whisper/auth.json or config.json " +
					"contains malformed JSON. Fix the file, then restart the daemon: " +
					"whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		}
	}

	const def = getWorkflowDefinition(deps.workflowType);
	let resolved: ReturnType<typeof resolveRoleBindings>;
	try {
		resolved = resolveRoleBindings({
			explicitImplementer: deps.implementer,
			explicitReviewer: deps.reviewer,
			callerAgent: deps.callerAgent ?? null,
			def,
		});
	} catch (e) {
		// Preserve the existing typed message for the no-defaults case; rethrow
		// everything else (e.g. the same-agent guard) untouched.
		if (e instanceof Error && /no default role bindings/.test(e.message)) {
			throw new Error(
				`Workflow type "${deps.workflowType}" has no default role bindings. Pass --implementer and --reviewer explicitly.`,
			);
		}
		throw e;
	}
	const { workflowId } = deps.broker.control.createWorkflow({
		collabId: deps.collabId,
		workflowType: deps.workflowType,
		specPath: deps.specPath,
		roleBindings: { implementer: resolved.implementer, reviewer: resolved.reviewer },
		...(deps.name ? { name: deps.name } : {}),
		now: deps.now,
	});
	return { workflowId, ...(resolved.warning ? { roleWarning: resolved.warning } : {}) };
}

type Agent = AgentType;

const otherAgent = (a: Agent): Agent => (a === "claude" ? "codex" : "claude");

/**
 * Resolve which agent implements and which reviews, by precedence:
 *   1. explicit flags  (either present → explicit; the missing side is filled
 *      as the opposite agent; both naming the same agent is rejected)
 *   2. caller-derived  (the triggering agent implements; the other reviews)
 *   3. definition default + a warning that no caller was detected
 */
export function resolveRoleBindings(input: {
	explicitImplementer?: Agent | undefined;
	explicitReviewer?: Agent | undefined;
	callerAgent?: Agent | null | undefined;
	def?: { defaultImplementer?: Agent; defaultReviewer?: Agent } | undefined;
}): { implementer: Agent; reviewer: Agent; source: "explicit" | "caller" | "default"; warning?: string } {
	const { explicitImplementer, explicitReviewer, callerAgent, def } = input;

	// 1. Explicit flags.
	if (explicitImplementer || explicitReviewer) {
		const implementer = explicitImplementer ?? (explicitReviewer ? otherAgent(explicitReviewer) : undefined);
		const reviewer = explicitReviewer ?? (explicitImplementer ? otherAgent(explicitImplementer) : undefined);
		if (implementer && reviewer) {
			if (implementer === reviewer) {
				throw new Error("implementer and reviewer cannot be the same agent");
			}
			return { implementer, reviewer, source: "explicit" };
		}
	}

	// 2. Caller-derived.
	if (callerAgent) {
		return { implementer: callerAgent, reviewer: otherAgent(callerAgent), source: "caller" };
	}

	// 3. Definition default + warning.
	const implementer = def?.defaultImplementer;
	const reviewer = def?.defaultReviewer;
	if (!implementer || !reviewer) {
		throw new Error("no default role bindings");
	}
	return {
		implementer,
		reviewer,
		source: "default",
		warning:
			`No triggering agent detected; defaulted to implementer=${implementer} / reviewer=${reviewer}. ` +
			"Pass --implementer / --reviewer to choose explicitly.",
	};
}

/** Validate an `AI_WHISPER_AGENT` value; anything but the two known agents is null. */
export function parseCallerAgent(raw: string | undefined): Agent | null {
	return raw === "claude" || raw === "codex" ? raw : null;
}
