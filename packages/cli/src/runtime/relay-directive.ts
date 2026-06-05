import {
	relayDirectiveSchema,
	type RelayDirective,
} from "@ai-whisper/shared";

const relayPattern =
	/^@@(?<target>codex|claude|ezio|pull)(?<force>\[new\])?\s*(?<instruction>.*)$/;
const unsupportedRelayPrefix = /^@@(?:codex|claude|ezio|pull)\[(?!new\])/;

export function parseRelayDirective(raw: string): RelayDirective | null {
	const trimmed = raw.trim();

	// Reject unsupported bracket syntax before attempting full parse
	if (unsupportedRelayPrefix.test(trimmed)) {
		return null;
	}

	const match = relayPattern.exec(trimmed);

	const groups = match?.groups;
	if (!groups?.target) {
		return null;
	}

	const instruction = (groups.instruction ?? "").trim();

	// codex and claude require a non-empty instruction; pull does not
	if (groups.target !== "pull" && instruction.length === 0) {
		return null;
	}

	return relayDirectiveSchema.parse({
		raw: trimmed,
		target: groups.target,
		forceNewThread: Boolean(groups.force),
		instruction,
	});
}

export function getRelayDirectiveError(raw: string): string | null {
	const trimmed = raw.trim();
	if (unsupportedRelayPrefix.test(trimmed)) {
		return "[ai-whisper] Unsupported relay syntax. Phase 6 supports only @@codex ..., @@claude ..., @@ezio ..., and [new].";
	}
	return null;
}
