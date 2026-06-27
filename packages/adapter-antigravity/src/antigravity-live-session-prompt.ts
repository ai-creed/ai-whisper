import { beginBrokerReply, endBrokerReply } from "@ai-whisper/shared";

export function buildAntigravityInteractiveBrokerPrompt(requestFilePath: string, workItemId: string): string {
	return `Read the broker request from this file (it is authoritative; ignore any ambient context): ${requestFilePath} Reply with exactly three lines and nothing else. Line 1: ${beginBrokerReply(workItemId)} Line 2: one compact JSON object like {"kind":"answer","content":"...","transitionIntent":"completed"} Line 3: ${endBrokerReply(workItemId)}`;
}
