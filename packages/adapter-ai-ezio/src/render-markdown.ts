/**
 * Dependency-free markdown → ANSI renderer for the mounted ezio pane (M8).
 *
 * Renders the FINAL assistant text (not a live stream) into a terminal-friendly
 * string: ATX headers, bold/italic, inline code, fenced code blocks (dim,
 * indented — no intra-block syntax highlight in v1), unordered/ordered lists,
 * blockquotes, and links. Unknown/edge markdown degrades to plain text. Pure
 * `string → string`; no external dependency (matches ai-whisper's no-heavy-deps
 * ethos + hax's look).
 *
 * v1 limitation: inline `*`/`_` inside inline code is not specially protected;
 * the common cases (bold/italic/code/links/lists/headers) are covered.
 */

const ESC = "\u001b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITAL = `${ESC}[3m`;
const CYAN = `${ESC}[36m`;
const RESET = `${ESC}[0m`;

function inline(s: string): string {
	return (
		s
			// inline code first (protects most content from bold/italic)
			.replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
			// bold (paired ** **) — an unclosed ** has no match and stays literal
			.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
			// italic (paired single * * or _ _)
			.replace(/(?:\*|_)([^*_\n]+)(?:\*|_)/g, `${ITAL}$1${RESET}`)
			// links: [text](url) -> text + dim url
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 ${DIM}$2${RESET}`)
	);
}

export function renderMarkdown(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			out.push(`${DIM}${line}${RESET}`);
			continue;
		}
		if (inFence) {
			// preserve content verbatim (no inline formatting), dim + indented
			out.push(`${DIM}  ${line}${RESET}`);
			continue;
		}
		const header = /^(#{1,6})\s+(.*)$/.exec(line);
		if (header) {
			out.push(`${BOLD}${inline(header[2])}${RESET}`);
			continue;
		}
		const ul = /^(\s*)[-*]\s+(.*)$/.exec(line);
		if (ul) {
			out.push(`${ul[1]}• ${inline(ul[2])}`);
			continue;
		}
		const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
		if (ol) {
			out.push(`${ol[1]}${ol[2]}. ${inline(ol[3])}`);
			continue;
		}
		const bq = /^>\s?(.*)$/.exec(line);
		if (bq) {
			out.push(`${DIM}│ ${inline(bq[1])}${RESET}`);
			continue;
		}
		out.push(inline(line));
	}
	return out.join("\n");
}
