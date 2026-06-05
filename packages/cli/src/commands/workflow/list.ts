import type { AgentType } from "@ai-whisper/shared";
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

export interface WorkflowListDeps {
	broker: {
		control: {
			listWorkflows: (filter: { collabId?: string }) => WorkflowRecord[];
		};
	};
	collabId?: string;
}

export function runWorkflowList(deps: WorkflowListDeps): WorkflowRecord[] {
	const filter: { collabId?: string } = {};
	if (deps.collabId !== undefined) {
		filter.collabId = deps.collabId;
	}
	return deps.broker.control.listWorkflows(filter);
}
