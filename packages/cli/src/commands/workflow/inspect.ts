import type { AgentType } from "@ai-whisper/shared";
export type WorkflowPhaseOutcome = "done" | "escalated" | "superseded";

export type WorkflowPhaseRunRecord = {
	phaseRunId: string;
	workflowId: string;
	phaseIndex: number;
	phaseName: string;
	chainId: string;
	startedAt: string;
	endedAt: string | null;
	outcome: WorkflowPhaseOutcome | null;
};

export type WorkflowStatus = "running" | "paused" | "halted" | "done" | "canceled";

export type WorkflowRecord = {
	workflowId: string;
	collabId: string;
	workflowType: string;
	name: string | null;
	specPath: string;
	roleBindings: Record<string, AgentType>;
	status: WorkflowStatus;
	currentPhaseIndex: number;
	haltReason: string | null;
	workflowContext: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

export interface WorkflowInspectDeps {
	broker: {
		control: {
			getWorkflow: (workflowId: string) => WorkflowRecord | null;
			getWorkflowPhaseRuns: (workflowId: string) => WorkflowPhaseRunRecord[];
		};
	};
	workflowId: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowInspect(
	deps: WorkflowInspectDeps,
): Promise<{ workflow: WorkflowRecord; phaseRuns: WorkflowPhaseRunRecord[] }> {
	const workflow = deps.broker.control.getWorkflow(deps.workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${deps.workflowId}`);
	}
	const phaseRuns = deps.broker.control.getWorkflowPhaseRuns(deps.workflowId);
	return { workflow, phaseRuns };
}
