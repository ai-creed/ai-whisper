function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(text: string): string {
	return text
		.split(/(`[^`]+`)/)
		.map((part, index) => {
			if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			return escapeHtml(part)
				.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
				.replace(/\*(.+?)\*/g, "<em>$1</em>");
		})
		.join("");
}

function renderBlock(lines: string[]): string {
	const first = lines[0] ?? "";
	const heading = lines.length === 1 ? /^(#{1,2}) +(.*)$/.exec(first) : null;
	if (heading) {
		const level = (heading[1] as string).length;
		return `<h${level}>${renderInline(heading[2] as string)}</h${level}>`;
	}
	return `<p>${renderInline(lines.join(" "))}</p>`;
}

function splitBlocks(src: string): string[][] {
	const blocks: string[][] = [];
	let current: string[] = [];
	for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
		if (raw.trim() === "") {
			if (current.length > 0) blocks.push(current);
			current = [];
		} else {
			current.push(raw.trim());
		}
	}
	if (current.length > 0) blocks.push(current);
	return blocks;
}

export function renderMarkdown(src: string): string {
	return splitBlocks(src).map(renderBlock).join("\n");
}
