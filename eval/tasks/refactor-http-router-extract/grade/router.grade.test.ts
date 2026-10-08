import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handle } from "../src/server.ts";

const ada = '{"id":"1","name":"ada"}';
const grace = '{"id":"42","name":"grace"}';
const notFound = { status: 404, body: "not found" };
const notAllowed = { status: 405, body: "method not allowed" };

const cases: Array<[string, string, { status: number; body: string }]> = [
	["GET", "/health", { status: 200, body: "ok" }],
	["GET", "/users", { status: 200, body: `[${ada},${grace}]` }],
	["GET", "/users/42", { status: 200, body: grace }],
	["GET", "/users/99", { status: 404, body: "user not found" }],
	["GET", "/nope", notFound],
	["POST", "/users", notAllowed],
	["DELETE", "/health", notAllowed],
	["POST", "/users/42", notAllowed],
	["GET", "/users/", notFound],
	["GET", "/health/", notFound],
	["GET", "/users/42/extra", notFound],
];

describe("router extraction (held-out)", () => {
	it("existing responses unchanged", () => {
		for (const [method, path, expected] of cases) {
			expect(handle({ method, path }), `${method} ${path}`).toEqual(expected);
		}
	});
	it("params parsed", async () => {
		const { Router } = await import("../src/router.ts");
		const router = new Router();
		const h = () => ({ status: 200, body: "x" });
		router.add("GET", "/users/:id", h);
		expect(router.match("GET", "/users/42")).toEqual({
			handler: h,
			params: { id: "42" },
		});
	});
	it("405 for wrong method", async () => {
		const { Router } = await import("../src/router.ts");
		const router = new Router();
		router.add("GET", "/users", () => ({ status: 200, body: "x" }));
		expect(router.match("POST", "/users")).toEqual({ status: 405 });
	});
	it("404 for no match", async () => {
		const { Router } = await import("../src/router.ts");
		const router = new Router();
		router.add("GET", "/users", () => ({ status: 200, body: "x" }));
		expect(router.match("GET", "/other")).toEqual({ status: 404 });
	});
	it("catch-all param", async () => {
		const { Router } = await import("../src/router.ts");
		const router = new Router();
		const h = () => ({ status: 200, body: "x" });
		router.add("GET", "/files/*", h);
		const result = router.match("GET", "/files/a/b.txt");
		expect(result).toEqual({ handler: h, params: { "*": "a/b.txt" } });
	});
	it("server has no inline path checks", () => {
		const src = readFileSync(`${import.meta.dirname}/../src/server.ts`, "utf8");
		expect(!/path ===|startsWith\(/.test(src)).toBe(true);
	});
	it("router is independently constructible", async () => {
		const { Router } = await import("../src/router.ts");
		const custom = new Router();
		const h = () => ({ status: 200, body: "custom" });
		custom.add("PUT", "/things/:kind/:id", h);
		expect(custom.match("PUT", "/things/box/7")).toEqual({
			handler: h,
			params: { kind: "box", id: "7" },
		});
		expect(custom.match("GET", "/things/box/7")).toEqual({ status: 405 });
		expect(custom.match("PUT", "/users/42")).toEqual({ status: 404 });
	});
});
