export interface ConfigInput {
	defaults: Record<string, unknown>;
	file?: string;
	env: Record<string, string>;
	overrides?: Record<string, unknown>;
}

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Dict, over: Dict): Dict {
	const out: Dict = { ...base };
	for (const [key, value] of Object.entries(over)) {
		if (key === "__proto__" || value === undefined) continue;
		const previous = out[key];
		out[key] = isPlainObject(value) ? deepMerge(isPlainObject(previous) ? previous : {}, value) : structuredClone(value);
	}
	return out;
}

export function loadConfig(input: ConfigInput): Dict {
	let result = deepMerge({}, input.defaults);

	if (input.file !== undefined && input.file !== "") {
		const parsed: unknown = JSON.parse(input.file);
		if (!isPlainObject(parsed)) throw new Error("config file must contain a JSON object");
		result = deepMerge(result, parsed);
	}

	const fromEnv: Dict = {};
	for (const [name, raw] of Object.entries(input.env)) {
		if (!name.startsWith("APP_")) continue;
		const segments = name.slice("APP_".length).split("__").map((s) => s.toLowerCase());
		if (segments.some((s) => s === "")) continue;
		let cursor = fromEnv;
		for (const segment of segments.slice(0, -1)) {
			const next = cursor[segment];
			if (isPlainObject(next)) cursor = next;
			else {
				const created: Dict = {};
				cursor[segment] = created;
				cursor = created;
			}
		}
		cursor[segments[segments.length - 1] as string] = raw;
	}
	result = deepMerge(result, fromEnv);

	if (input.overrides) result = deepMerge(result, input.overrides);
	return result;
}
