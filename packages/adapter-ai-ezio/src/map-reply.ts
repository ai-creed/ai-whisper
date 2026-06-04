import { mockProviderReplySchema, type ProviderReply } from "@ai-whisper/shared";

const EMPTY_TURN_FALLBACK = "(no textual response; tool-only turn)";
const FAILURE_FALLBACK = "ai-ezio turn failed";

export type TurnOutcome =
	| { ok: true; content: string }
	| { ok: false; error: string };

/** Maps a finished ai-ezio turn to a schema-valid ProviderReply. A valid
 *  protocol event (including an empty tool-only turn) can never yield an
 *  invalid reply: content is always non-empty and kind is always a live
 *  replyKind. */
export function mapTurnToReply(outcome: TurnOutcome): ProviderReply {
	if (!outcome.ok) {
		return mockProviderReplySchema.parse({
			kind: "failure",
			content: outcome.error.length > 0 ? outcome.error : FAILURE_FALLBACK,
			transitionIntent: "failed",
		});
	}
	return mockProviderReplySchema.parse({
		kind: "answer",
		content: outcome.content.length > 0 ? outcome.content : EMPTY_TURN_FALLBACK,
		transitionIntent: null,
	});
}
