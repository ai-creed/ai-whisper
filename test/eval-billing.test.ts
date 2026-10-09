import { describe, expect, it } from "vitest";
import { BillingPreflightError, checkBillingPreflight, readClaudeAuthStatus } from "../eval/runner/billing.ts";
import { HarnessFailure } from "../eval/runner/types.ts";

type Exec = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => string;
const status = (authMethod: string, loggedIn = authMethod !== "none"): string => JSON.stringify({ loggedIn, authMethod, apiProvider: "firstParty" });
const baseEnv = { HOME: "/h", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-x", npm_lifecycle_event: "eval" };

describe("readClaudeAuthStatus", () => {
	it("asks `claude auth status --json` and returns the login method", () => {
		let seen: { cmd: string; args: string[] } | null = null;
		const exec: Exec = (cmd, args) => { seen = { cmd, args }; return status("claude.ai"); };
		expect(readClaudeAuthStatus(baseEnv, exec)).toEqual({ loggedIn: true, authMethod: "claude.ai" });
		expect(seen).toEqual({ cmd: "claude", args: ["auth", "status", "--json"] });
	});
	it("wraps a missing or broken claude binary as a harness failure", () => {
		const exec: Exec = () => { throw new Error("spawn claude ENOENT"); };
		expect(() => readClaudeAuthStatus(baseEnv, exec)).toThrow(HarnessFailure);
	});
	it("wraps unparseable output as a harness failure that quotes it", () => {
		const exec: Exec = () => "not json";
		expect(() => readClaudeAuthStatus(baseEnv, exec)).toThrow(/not json/);
	});
});

describe("checkBillingPreflight", () => {
	it("subscription: passes when claude falls back to its claude.ai login once the API key is scrubbed", () => {
		let envSeen: NodeJS.ProcessEnv = {};
		const exec: Exec = (_c, _a, env) => { envSeen = env; return status("claude.ai"); };
		expect(() => checkBillingPreflight("subscription", baseEnv, "/repo", exec)).not.toThrow();
		expect("ANTHROPIC_API_KEY" in envSeen).toBe(false); // probed with the same env the agents will get
		expect("npm_lifecycle_event" in envSeen).toBe(false);
	});
	it("subscription: refuses before any spend when claude has no claude.ai login, naming both remedies", () => {
		const exec: Exec = () => status("none");
		expect(() => checkBillingPreflight("subscription", baseEnv, "/repo", exec)).toThrow(BillingPreflightError);
		expect(() => checkBillingPreflight("subscription", baseEnv, "/repo", exec)).toThrow(/claude\.ai.*log in.*--billing api/s);
	});
	it("subscription: refuses when claude would still bill an API key from somewhere the scrub cannot reach", () => {
		const exec: Exec = () => status("api_key");
		expect(() => checkBillingPreflight("subscription", baseEnv, "/repo", exec)).toThrow(/api_key/);
	});
	it("api: passes when an Anthropic credential is in the agent env and never probes claude", () => {
		let calls = 0;
		const exec: Exec = () => { calls++; return status("api_key"); };
		expect(() => checkBillingPreflight("api", baseEnv, "/repo", exec)).not.toThrow();
		expect(() => checkBillingPreflight("api", { HOME: "/h", ANTHROPIC_AUTH_TOKEN: "tok" }, "/repo", exec)).not.toThrow();
		expect(calls).toBe(0);
	});
	it("api: refuses when no Anthropic credential is set, naming the variable and the subscription alternative", () => {
		const exec: Exec = () => status("claude.ai");
		expect(() => checkBillingPreflight("api", { HOME: "/h" }, "/repo", exec)).toThrow(BillingPreflightError);
		expect(() => checkBillingPreflight("api", { HOME: "/h" }, "/repo", exec)).toThrow(/ANTHROPIC_API_KEY.*--billing subscription/s);
	});
});
