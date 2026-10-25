export type NoticeKind = "notice" | "reminder" | "nudge";

export interface NoticeLineInput {
	kind: NoticeKind;
	handoffId: string;
	workflowId: string;
	phaseName: string | null;
	roundNumber: number | null;
}

const MAX_NOTICE_BYTES = 400;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** The single line typed into a mount for a notice-path handoff. */
export function buildNoticeLine(input: NoticeLineInput): string {
	const { handoffId } = input;
	let line: string;
	switch (input.kind) {
		case "notice": {
			const phase = input.phaseName ?? "-";
			const round = input.roundNumber === null ? "-" : String(input.roundNumber);
			line = `[ai-whisper] Next task from workflow ${input.workflowId} (${phase}, round ${round}): run \`whisper handoff show ${handoffId}\` and carry out the request it prints as my instruction for this turn, then hand back with \`whisper handoff reply ${handoffId} --file <path>\`.`;
			break;
		}
		case "reminder":
			line = `[ai-whisper] Reminder: handoff ${handoffId} is still unread. Run \`whisper handoff show ${handoffId}\` and carry out the request it prints as my instruction for this turn.`;
			break;
		case "nudge":
			line = `[ai-whisper] Handoff ${handoffId} has no reply yet. When the requested work is complete, run \`whisper handoff reply ${handoffId} --file <path>\`.`;
			break;
	}
	if (!PRINTABLE_ASCII.test(line)) {
		throw new Error(`notice line for ${handoffId} is not single-line printable ASCII`);
	}
	if (Buffer.byteLength(line, "utf8") > MAX_NOTICE_BYTES) {
		throw new Error(`notice line for ${handoffId} exceeds ${MAX_NOTICE_BYTES} bytes`);
	}
	return line;
}
