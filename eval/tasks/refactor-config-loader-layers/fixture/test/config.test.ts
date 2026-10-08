import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const defaults = { port: 3000, db: { host: "localhost", port: 5432 }, tags: ["a", "b"], debug: false };

describe("loadConfig", () => {
	it("returns the defaults when nothing else is set", () => {
		expect(loadConfig({ defaults, env: {} })).toEqual(defaults);
	});

	it("does not mutate the defaults", () => {
		const copy = structuredClone(defaults);
		loadConfig({ defaults, env: { APP_DB__HOST: "x" }, overrides: { port: 1 } });
		expect(defaults).toEqual(copy);
	});

	it("file overrides defaults and merges nested objects", () => {
		expect(loadConfig({ defaults, file: '{"db":{"host":"filehost"},"extra":1}', env: {} })).toEqual({
			port: 3000,
			db: { host: "filehost", port: 5432 },
			tags: ["a", "b"],
			debug: false,
			extra: 1,
		});
	});

	it("env overrides file and parses APP_ keys with __ nesting, without coercion", () => {
		const out = loadConfig({ defaults, file: '{"port":4000}', env: { APP_PORT: "5000", APP_DB__PORT: "6543", APP_DEBUG: "true", OTHER: "ignored" } });
		expect(out).toEqual({ port: "5000", db: { host: "localhost", port: "6543" }, tags: ["a", "b"], debug: "true" });
	});

	it("lowercases env keys and ignores keys that are not a clean path", () => {
		expect(loadConfig({ defaults: {}, env: { APP_Feature__Flag_X: "1", APP_: "2", APP_A____B: "3" } })).toEqual({ feature: { flag_x: "1" } });
	});

	it("overrides win over everything", () => {
		const out = loadConfig({ defaults, file: '{"port":4000}', env: { APP_PORT: "5000" }, overrides: { port: 8080 } });
		expect(out.port).toBe(8080);
	});

	it("replaces arrays instead of merging them", () => {
		expect(loadConfig({ defaults, file: '{"tags":["x"]}', env: {}, overrides: { tags: ["y", "z"] } }).tags).toEqual(["y", "z"]);
	});

	it("lets a scalar replace an object and an object replace a scalar", () => {
		expect(loadConfig({ defaults, env: { APP_DB: "none" } }).db).toBe("none");
		expect(loadConfig({ defaults, env: { APP_PORT__PRIMARY: "1" } }).port).toEqual({ primary: "1" });
	});

	it("rejects invalid JSON and non-object files", () => {
		expect(() => loadConfig({ defaults, file: "{nope", env: {} })).toThrow();
		expect(() => loadConfig({ defaults, file: "[1]", env: {} })).toThrow("config file must contain a JSON object");
	});

	it("treats an empty file string as no file", () => {
		expect(loadConfig({ defaults, file: "", env: {} })).toEqual(defaults);
	});
});
