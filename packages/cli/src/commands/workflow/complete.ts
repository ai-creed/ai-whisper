export interface WorkflowCompleteDeps {
	broker: {
		control: {
			markWorkflowDone: (input: { workflowId: string; now: string }) => void;
		};
	};
	workflowId: string;
	now: string;
}

// markWorkflowDone is synchronous; async wrapper kept so callers can uniformly
// await workflow commands and catch thrown errors via Promise rejection.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowComplete(deps: WorkflowCompleteDeps): Promise<void> {
	deps.broker.control.markWorkflowDone({ workflowId: deps.workflowId, now: deps.now });
}
