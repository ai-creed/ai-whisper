import {
	extractJsonObjectCandidates,
	mockProviderReplySchema,
	type ProviderReply,
} from "@ai-whisper/shared";

function failure(content: string): ProviderReply {
	return { kind: "failure", content, transitionIntent: "failed" };
}

/**
 * Parse Cursor's `--output-format json` stdout into a ProviderReply.
 *
 * Two layers:
 *  1. The OUTER envelope is strict JSON — Cursor emits exactly one object after
 *     the agent finishes: `{ type, subtype, is_error, result, ... }`. A
 *     non-success subtype, an `is_error` flag, or unparseable stdout is a
 *     failure (Cursor writes nothing to stdout on a hard error, so empty/garbage
 *     stdout lands here too).
 *  2. The INNER `result` string is where the model's reply lives. Because the
 *     prompt asks for a JSON reply, try to recover a structured reply even when
 *     the model fenced it or wrapped it in prose (shared brace-extraction). If
 *     none validates, fall back to wrapping the raw text as an `answer`.
 */
export function parseCursorOutput(stdout: string): ProviderReply {
	let envelope: Record<string, unknown>;
	try {
		envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;
	} catch {
		return failure("Cursor output did not contain a JSON result envelope");
	}

	if (envelope["is_error"] === true || envelope["subtype"] !== "success") {
		return failure("Cursor output was not a successful result");
	}

	const result = typeof envelope["result"] === "string" ? envelope["result"] : "";
	if (result.trim().length === 0) {
		return failure("Cursor result was empty");
	}

	const candidates = extractJsonObjectCandidates(result);
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (candidate === undefined) {
			continue;
		}
		try {
			return mockProviderReplySchema.parse(JSON.parse(candidate));
		} catch {
			// keep looking for the last valid provider reply object
		}
	}

	// The model returned prose rather than the requested JSON reply — surface it
	// as an answer so the workflow keeps moving instead of hard-failing.
	return { kind: "answer", content: result, transitionIntent: null };
}
