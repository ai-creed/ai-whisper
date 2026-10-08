import type { Report } from "./types.ts";

export function formatReport(
	report: Report,
	format: "text" | "json" | "csv",
): string {
	switch (format) {
		case "text": {
			const lines: string[] = [];
			lines.push(report.title);
			lines.push("=".repeat(report.title.length));
			for (const row of report.rows) {
				lines.push(row.name + ": " + String(row.value));
			}
			return lines.join("\n");
		}
		case "json": {
			const out = {
				title: report.title,
				rows: report.rows.map((row) => ({ name: row.name, value: row.value })),
			};
			return JSON.stringify(out, null, 2);
		}
		case "csv": {
			const lines: string[] = [];
			lines.push("name,value");
			for (const row of report.rows) {
				lines.push(row.name + "," + String(row.value));
			}
			return lines.join("\n");
		}
		default:
			throw new Error(`unknown format ${String(format)}`);
	}
}
