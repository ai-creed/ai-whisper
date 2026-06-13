import type { InteractiveSessionController } from "@ai-whisper/shared";

/**
 * Deliver relayed/injected agent input to the interactive session.
 *
 * This is the ONLY path agent-originated (relayed/injected) input takes into
 * the session, and it deliberately does just one thing: submit the value as a
 * turn via `writeUserInput`. It MUST NOT consult `tryConsumeLocalCommand` — a
 * relayed line that happens to start with `/` is real turn content, never an
 * operator slash command. Operator slash-command interception lives solely in
 * the line-input hook (`live-session.ts`); routing injected input through that
 * seam would let a peer agent trigger local commands.
 */
export function injectedWrite(
	session: Pick<InteractiveSessionController, "writeUserInput">,
	value: string,
): void {
	session.writeUserInput(value);
}
