const FRAGMENT_OPEN = "--- ai-whisper handback ---";

function handbackFragment(handoffId: string): string {
	return `${FRAGMENT_OPEN}
When the requested work is complete, write your complete handback to a file and run:
  whisper handoff reply ${handoffId} --file <path>
At the end of every turn in which you completed what you were asked, run: whisper turn done
--- end handback ---`;
}

/**
 * Appends the handback instructions (naming this handoff's own id) to a stored
 * workflow request. Applied where the handoff id is generated, since the text
 * builders do not know the id yet. Idempotent.
 */
export function withHandbackFragment(requestText: string, handoffId: string): string {
	const fragment = handbackFragment(handoffId);
	if (requestText.includes(fragment)) return requestText;
	return `${requestText}\n\n${fragment}`;
}
