import type { ProviderWorkRequest } from "@ai-whisper/shared";

export function buildAntigravityPrompt(request: ProviderWorkRequest): string {
	return [
		"Return ONLY valid JSON.",
		"{",
		'  "kind": "answer" | "review" | "clarification" | "failure",',
		'  "content": "string",',
		'  "transitionIntent": "in_progress" | "awaiting_user" | "completed" | "failed" | null',
		"}",
		"",
		`action: ${request.requestedAction}`,
		`instruction: ${request.instruction}`,
		`collabId: ${request.collabId}`,
		`threadId: ${request.threadId}`,
		`workItemId: ${request.workItemId}`,
	].join("\n");
}

export function buildAntigravityFileBackedBrokerPrompt(requestFilePath: string): string {
	return [
		"Return ONLY valid JSON matching this schema:",
		"{",
		'  "kind": "answer" | "review" | "clarification" | "failure",',
		'  "content": "string",',
		'  "transitionIntent": "in_progress" | "awaiting_user" | "completed" | "failed" | null',
		"}",
		"",
		`The work request is in the file: ${requestFilePath}`,
		"That file is the authoritative source of truth. Read it and respond to the instruction in it.",
	].join("\n");
}
