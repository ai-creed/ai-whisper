/** Minimal CSV: comma-separated fields, LF/CRLF-separated rows. No quoting yet. */
export function parseCsv(text: string): string[][] {
	const rows = text.split(/\r?\n/);
	if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows.map((line) => line.split(","));
}
