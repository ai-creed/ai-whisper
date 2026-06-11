// Single capture-side drafting/scratchpad heuristic (spec §4.3 / §12 Q4).
// The evaluator's LLM rejection remains the authoritative backstop; this is the
// belt that makes the capture layer RETRY instead of delivering a fragment.
const DRAFTING_PREFIXES = [
	"let's draft",
	"lets draft",
	"let me draft",
	"maybe",
	"need ",
	"need:",
	"i'll draft",
	"draft:",
	"thinking",
	"let me think",
	"first,",
	"okay,",
	"ok,",
	"hmm",
];

export function isMidCompositionShape(message: string): boolean {
	const trimmed = message.trim();
	if (trimmed.length === 0) return true;
	const lower = trimmed.toLowerCase();
	// Pure ellipsis / punctuation fragment.
	if (/^[.…\-\s]+$/.test(trimmed)) return true;
	// Short, unstructured, and starting with a drafting cue → mid-composition.
	const hasStructure = /[|`]|^\s*[-*\d]+[.)]\s|\n/.test(trimmed);
	if (hasStructure) return false;
	if (trimmed.length < 40 && DRAFTING_PREFIXES.some((p) => lower.startsWith(p))) {
		return true;
	}
	// Very short single-word/clause with no structure.
	if (trimmed.length < 12 && !trimmed.includes(" ")) return true;
	return false;
}
