import { describe, expect, it } from "vitest";
import { handle } from "../src/server.ts";

const ada = '{"id":"1","name":"ada"}';
const grace = '{"id":"42","name":"grace"}';

describe("handle", () => {
	it("serves the health check", () => {
		expect(handle({ method: "GET", path: "/health" })).toEqual({
			status: 200,
			body: "ok",
		});
	});
	it("lists users", () => {
		expect(handle({ method: "GET", path: "/users" })).toEqual({
			status: 200,
			body: `[${ada},${grace}]`,
		});
	});
	it("returns one user by id", () => {
		expect(handle({ method: "GET", path: "/users/42" })).toEqual({
			status: 200,
			body: grace,
		});
	});
	it("returns 404 for an unknown user id", () => {
		expect(handle({ method: "GET", path: "/users/99" })).toEqual({
			status: 404,
			body: "user not found",
		});
	});
	it("returns 404 for an unknown path", () => {
		expect(handle({ method: "GET", path: "/nope" })).toEqual({
			status: 404,
			body: "not found",
		});
	});
	it("returns 405 for a known path with the wrong method", () => {
		const expected = { status: 405, body: "method not allowed" };
		expect(handle({ method: "POST", path: "/users" })).toEqual(expected);
		expect(handle({ method: "DELETE", path: "/health" })).toEqual(expected);
		expect(handle({ method: "POST", path: "/users/42" })).toEqual(expected);
	});
	it("does not tolerate trailing slashes: they are 404, not an alias", () => {
		const expected = { status: 404, body: "not found" };
		expect(handle({ method: "GET", path: "/users/" })).toEqual(expected);
		expect(handle({ method: "GET", path: "/health/" })).toEqual(expected);
		expect(handle({ method: "GET", path: "/users/42/" })).toEqual(expected);
	});
	it("returns 404 for extra path segments", () => {
		expect(handle({ method: "GET", path: "/users/42/extra" })).toEqual({
			status: 404,
			body: "not found",
		});
	});
});
