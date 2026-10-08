export type FlagKind = "boolean" | "string";

export interface ArgSpec {
	flags: Record<string, FlagKind>;
}

export interface ParsedArgs {
	flags: Record<string, string | boolean>;
	positionals: string[];
}

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positionals: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;

		if (token === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}

		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}

		const body = token.slice(2);
		const eq = body.indexOf("=");
		const name = eq === -1 ? body : body.slice(0, eq);
		const kind = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
		if (kind === undefined) {
			throw new Error(`unrecognized option --${name}`);
		}

		if (kind === "boolean") {
			if (eq !== -1) throw new Error(`flag --${name} does not take a value`);
			flags[name] = true;
			continue;
		}

		if (eq !== -1) {
			flags[name] = body.slice(eq + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined) throw new Error(`missing value for --${name}`);
		flags[name] = next;
		i++;
	}

	return { flags, positionals };
}
