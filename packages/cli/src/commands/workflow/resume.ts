export interface WorkflowResumeDeps {
	broker: {
		control: {
			resumeWorkflow: (input: {
				workflowId: string;
				now: string;
				message?: string;
			}) => void;
		};
	};
	workflowId: string;
	now: string;
	/** Optional operator note delivered to the agents on resume (paused and halted workflows). */
	message?: string;
}

// resumeWorkflow is synchronous; async wrapper kept so callers can uniformly
// await workflow commands and catch thrown errors via Promise rejection.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowResume(deps: WorkflowResumeDeps): Promise<void> {
	deps.broker.control.resumeWorkflow({
		workflowId: deps.workflowId,
		now: deps.now,
		...(deps.message !== undefined ? { message: deps.message } : {}),
	});
}
