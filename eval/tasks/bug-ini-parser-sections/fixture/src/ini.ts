export type IniData = Record<string, Record<string, string>>;

function parseValue(raw: string): string {
	let value = raw.trim();
	const comment = value.search(/[;#]/);
	if (comment !== -1) {
		value = value.slice(0, comment).trim();
	}
	value = value.replace(/^"|"$/g, "");
	return value.replace(/\\"/g, '"');
}

export function parseIni(text: string): IniData {
	const result: IniData = {};
	let current: Record<string, string> | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith(";") || line.startsWith("#")) {
			continue;
		}
		const header = /^\[(.*)\]$/.exec(line);
		if (header) {
			current = {};
			result[(header[1] ?? "").trim()] = current;
			continue;
		}
		const eq = line.indexOf("=");
		if (eq === -1 || current === undefined) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		current[key] = parseValue(line.slice(eq + 1));
	}
	return result;
}
