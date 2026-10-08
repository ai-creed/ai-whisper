import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";

interface Loaded {
	value: Record<string, unknown>;
	provenance: Record<string, string>;
	explain(path: string): string;
}

function load(input: { defaults: Record<string, unknown>; file?: string; env: Record<string, string>; overrides?: Record<string, unknown> }): Loaded {
	return loadConfig(input) as unknown as Loaded;
}

const base = { port: 3000, db: { host: "localhost", port: 5432 }, tags: ["a", "b"], debug: false };

describe("refactor-config-loader-layers (held-out)", () => {
	it("value is byte-identical to the previous output", () => {
		const cases: Array<[Parameters<typeof load>[0], string]> = [
			[
				{ defaults: base, file: '{"db":{"host":"filehost"},"tags":["x"]}', env: { APP_DB__PORT: "6543", APP_DEBUG: "true", OTHER: "x" }, overrides: { port: 8080 } },
				'{"port":8080,"db":{"host":"filehost","port":"6543"},"tags":["x"],"debug":"true"}',
			],
			[
				{ defaults: {}, env: { APP_A__B: "1", APP_A__C: "2", APP_Z: "9" }, overrides: { a: { b: "over" } } },
				'{"a":{"b":"over","c":"2"},"z":"9"}',
			],
			[
				{ defaults: { a: { b: 1, c: [1, 2] }, k: "d" }, file: '{"k":{"x":1},"a":{"c":[3]}}', env: { APP_K__Y: "2" }, overrides: { n: null } },
				'{"a":{"b":1,"c":[3]},"k":{"x":1,"y":"2"},"n":null}',
			],
			[{ defaults: { d: 1 }, file: '{"f":1}', env: { APP_E: "1" }, overrides: { o: 1 } }, '{"d":1,"f":1,"e":"1","o":1}'],
		];
		for (const [input, expected] of cases) expect(JSON.stringify(load(input).value)).toBe(expected);
	});

	it("provenance of a path is the last source that set it", () => {
		const out = load({ defaults: base, file: '{"db":{"host":"filehost"}}', env: { APP_DB__PORT: "1" }, overrides: { debug: true } });
		expect(out.provenance["db.host"]).toBe("file");
		expect(out.provenance["db.port"]).toBe("env");
		expect(out.provenance["debug"]).toBe("overrides");
		expect(out.provenance["port"]).toBe("defaults");
		const replaced = load({ defaults: { a: { b: 1 } }, env: { APP_A: "x" } });
		expect(replaced.value).toEqual({ a: "x" });
		expect(replaced.provenance).toEqual({ a: "env" });
	});

	it("arrays are replaced not merged and provenance points at the array path", () => {
		const out = load({ defaults: { tags: [1, 2, 3] }, env: {}, overrides: { tags: [9] } });
		expect(out.value).toEqual({ tags: [9] });
		expect(out.provenance).toEqual({ tags: "overrides" });
	});

	it("explain has the exact format", () => {
		const out = load({ defaults: { port: 3000, a: { b: 1 } }, file: '{"a":{"b":"x"}}', env: {}, overrides: { tags: ["y"] } });
		expect(out.explain("a.b")).toBe('a.b = "x" (from file)');
		expect(out.explain("port")).toBe("port = 3000 (from defaults)");
		expect(out.explain("tags")).toBe('tags = ["y"] (from overrides)');
	});

	it("a source that returns nothing contributes no provenance", () => {
		const out = load({ defaults: { a: 1 }, env: { UNRELATED: "x" } });
		expect(out.value).toEqual({ a: 1 });
		expect(out.provenance).toEqual({ a: "defaults" });
		expect(Object.values(out.provenance)).not.toContain("file");
		expect(Object.values(out.provenance)).not.toContain("env");
		expect(Object.values(out.provenance)).not.toContain("overrides");
	});

	it("sources load in the fixed order defaults, file, env, overrides", () => {
		const everywhere = { defaults: { k: 1 }, file: '{"k":2}', env: { APP_K: "3" }, overrides: { k: 4 } };
		expect(load(everywhere).provenance["k"]).toBe("overrides");
		expect(load({ ...everywhere, overrides: undefined }).provenance["k"]).toBe("env");
		expect(load({ ...everywhere, overrides: undefined, env: {} }).provenance["k"]).toBe("file");
		expect(load({ ...everywhere, overrides: undefined, env: {}, file: undefined }).provenance["k"]).toBe("defaults");
		const keys = load({ defaults: { d: 1 }, file: '{"f":1}', env: { APP_E: "1" }, overrides: { o: 1 } });
		expect(Object.keys(keys.value)).toEqual(["d", "f", "e", "o"]);
	});

	it("config.ts no longer contains the env-prefix logic", () => {
		const src = readFileSync(`${import.meta.dirname}/../src/config.ts`, "utf8");
		expect(!/APP_/.test(src)).toBe(true);
	});

	it("sources are independently importable", async () => {
		const { envSource } = await import("../src/sources/env.ts");
		const source = envSource({ APP_A__B: "1", APP_TOP: "x", OTHER: "ignored" });
		expect(source.name).toBe("env");
		expect(source.load()).toEqual({ a: { b: "1" }, top: "x" });
	});
});
