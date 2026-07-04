import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { agentTypes, type AgentType } from "@ai-whisper/shared";
import { getBrokerDaemonByCollab, getWorkflowDefinition, validateTaskBrief } from "@ai-whisper/broker";
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
			listSessionBindings: (
				collabId: string,
			) => Array<{ agentType: string; bindingState: string }>;
		};
	};
	collabId: string;
	workflowType: string;
	specPath: string;
	/** Reads the task-brief file at `specPath` for the quick-task scope gate; defaults to `readFileSync(path, "utf8")`. */
	readTaskBrief?: (path: string) => string;
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
		} else if (evaluatorStatus === "missing_openai_key") {
			throw new Error(
				"Evaluator is not configured: OPENAI_API_KEY is missing. " +
					"Add it to ~/.ai-whisper/auth.json as { \"OPENAI_API_KEY\": \"sk-...\" } " +
					"(mode 600) or export OPENAI_API_KEY, then restart the daemon: whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		} else if (evaluatorStatus === "agent_cli_unavailable") {
			throw new Error(
				"Evaluator is not configured: the agent-cli executable was not found on PATH. " +
					"Install/mount the agent CLI (claude/codex/agy) or set evaluator.agentCli.executable to its absolute path, " +
					"then restart the daemon: whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		} else {
			// invalid_config: malformed JSON OR a required setting is missing
			// (provider=openai without a model; provider=agent-cli without an agent).
			throw new Error(
				"Evaluator configuration is invalid: a required setting is missing or " +
					"~/.ai-whisper/auth.json / config.json contains malformed JSON. " +
					"For provider=openai set evaluator.openai.model (AI_WHISPER_EVALUATOR_OPENAI_MODEL); " +
					"for provider=agent-cli set the agent (AI_WHISPER_EVALUATOR_AGENT_CLI_AGENT). " +
					"Fix the config, then restart the daemon: whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		}
	}

	// Hard scope gate: quick-task briefs must pass validateTaskBrief before
	// anything is persisted. Runs after the evaluator preflight and before role
	// resolution so brief problems surface first with no half-created workflow.
	if (deps.workflowType === "quick-task") {
		const read = deps.readTaskBrief ?? ((p: string) => readFileSync(p, "utf8"));
		let briefContent: string;
		try {
			briefContent = read(deps.specPath);
		} catch {
			throw new Error(
				`Task brief not readable at ${deps.specPath}. Check the path and try again.`,
			);
		}
		const brief = validateTaskBrief(briefContent);
		if (!brief.ok) {
			throw new Error(
				"Task brief failed the quick-task scope gate:\n" +
					brief.violations.map((v) => `  - ${v}`).join("\n") +
					"\nSplit the task or use spec-driven-development.",
			);
		}
	}

	const def = getWorkflowDefinition(deps.workflowType);
	// The two agents actually bound in this collab; "the other role" is resolved
	// from this set (replacement model), so ezio-replaces-codex pairs correctly.
	const boundAgents = deps.broker.control
		.listSessionBindings(deps.collabId)
		.filter((b) => b.bindingState === "bound")
		.map((b) => b.agentType)
		.filter((t): t is AgentType => (agentTypes as readonly string[]).includes(t));
	let resolved: ReturnType<typeof resolveRoleBindings>;
	try {
		resolved = resolveRoleBindings({
			explicitImplementer: deps.implementer,
			explicitReviewer: deps.reviewer,
			callerAgent: deps.callerAgent ?? null,
			boundAgents,
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

// Resolve "the other role's agent" from the agents actually bound in the collab.
// Falls back to the literal codex<->claude flip ONLY when bindings don't yield a
// distinct partner — preserving existing two-agent behavior and tests. ezio has
// no literal partner, so an ezio role with no second bound agent is surfaced as
// an explicit error rather than guessed (the replacement model needs both bound).
function otherAgent(a: Agent, boundAgents?: readonly Agent[]): Agent {
	if (boundAgents) {
		const partner = boundAgents.find((b) => b !== a);
		if (partner) return partner;
	}
	if (a === "claude") return "codex";
	if (a === "codex") return "claude";
	throw new Error(
		`Cannot infer the partner agent for "${a}" without a second bound agent; ` +
			"pass --implementer and --reviewer explicitly.",
	);
}

/**
 * Resolve which agent implements and which reviews, by precedence:
 *   1. explicit flags  (either present → explicit; the missing side is filled
 *      from the other bound agent; both naming the same agent is rejected)
 *   2. caller-derived  (the triggering agent implements; the other bound reviews)
 *   3. definition default + a warning that no caller was detected
 */
export function resolveRoleBindings(input: {
	explicitImplementer?: Agent | undefined;
	explicitReviewer?: Agent | undefined;
	callerAgent?: Agent | null | undefined;
	boundAgents?: readonly Agent[] | undefined;
	def?: { defaultImplementer?: Agent; defaultReviewer?: Agent } | undefined;
}): { implementer: Agent; reviewer: Agent; source: "explicit" | "caller" | "default"; warning?: string } {
	const { explicitImplementer, explicitReviewer, callerAgent, boundAgents, def } = input;

	// 1. Explicit flags.
	if (explicitImplementer || explicitReviewer) {
		const implementer = explicitImplementer ?? (explicitReviewer ? otherAgent(explicitReviewer, boundAgents) : undefined);
		const reviewer = explicitReviewer ?? (explicitImplementer ? otherAgent(explicitImplementer, boundAgents) : undefined);
		if (implementer && reviewer) {
			if (implementer === reviewer) {
				throw new Error("implementer and reviewer cannot be the same agent");
			}
			return { implementer, reviewer, source: "explicit" };
		}
	}

	// 2. Caller-derived.
	if (callerAgent) {
		return { implementer: callerAgent, reviewer: otherAgent(callerAgent, boundAgents), source: "caller" };
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

/** Validate an `AI_WHISPER_AGENT` value; anything but a known agent type is null. */
export function parseCallerAgent(raw: string | undefined): Agent | null {
	return raw !== undefined && (agentTypes as readonly string[]).includes(raw) ? (raw as Agent) : null;
}
