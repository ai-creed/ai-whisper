import type { ProviderWorkRequest, ProviderWorkContext } from "@ai-whisper/shared";

/** ai-ezio drives a real model, so the instruction text is the prompt. We pass
 *  it through verbatim (the broker already composes role/context into
 *  `instruction`); the requestedAction is a thin header for situational
 *  awareness, and the artifact request-file path is appended when the broker
 *  supplied an artifact handle so the engine can read the full payload. */
export function buildAiEzioPrompt(
	request: ProviderWorkRequest,
	context?: ProviderWorkContext,
): string {
	const lines = [`[ai-whisper:${request.requestedAction}]`, request.instruction];
	if (context?.artifactHandle) {
		lines.push(
			`\nThe full request file is available at: ${context.artifactHandle.requestFilePath}`,
		);
	}
	return lines.join("\n");
}
