import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BillingPreflightError, checkBillingPreflight, readClaudeAuthStatus } from "../eval/runner/billing.ts";
import { HarnessFailure } from "../eval/runner/types.ts";

type Exec = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => string;
const status = (authMethod: string, loggedIn = authMethod !== "none"): string => JSON.stringify({ loggedIn, authMethod, apiProvider: "firstParty" });
const baseEnv = { HOME: "/h", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-x", npm_lifecycle_event: "eval" };
const noEvaluatorKeyNeeded = { provider: "ollama", model: "m", fallbackProvider: null, fallbackModel: null };
const anthropicEvaluator = { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null };
const input = (billing: "subscription" | "api", over: Partial<Parameters<typeof checkBillingPreflight>[0]> = {}) =>
	({ billing, env: baseEnv, repoRoot: "/repo", evaluator: noEvaluatorKeyNeeded, sourceStateRoot: "/nowhere", ...over });

describe("readClaudeAuthStatus", () => {
	it("asks `claude auth status --json` and returns the login method", () => {
		let seen: { cmd: string; args: string[] } | null = null;
		const exec: Exec = (cmd, args) => { seen = { cmd, args }; return status("claude.ai"); };
		expect(readClaudeAuthStatus(baseEnv, exec)).toEqual({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
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
		expect(() => checkBillingPreflight(input("subscription"), exec)).not.toThrow();
		expect("ANTHROPIC_API_KEY" in envSeen).toBe(false); // probed with the same env the agents will get
		expect("npm_lifecycle_event" in envSeen).toBe(false);
	});
	it("subscription: refuses before any spend when claude has no claude.ai login, naming both remedies", () => {
		const exec: Exec = () => status("none");
		expect(() => checkBillingPreflight(input("subscription"), exec)).toThrow(BillingPreflightError);
		expect(() => checkBillingPreflight(input("subscription"), exec)).toThrow(/claude\.ai.*log in.*--billing api/s);
	});
	it("subscription: refuses when claude would still bill an API key from somewhere the scrub cannot reach", () => {
		const exec: Exec = () => status("api_key");
		expect(() => checkBillingPreflight(input("subscription"), exec)).toThrow(/api_key/);
	});
	it("api: passes when an Anthropic credential is in the agent env and never probes claude", () => {
		let calls = 0;
		const exec: Exec = () => { calls++; return status("api_key"); };
		expect(() => checkBillingPreflight(input("api"), exec)).not.toThrow();
		expect(() => checkBillingPreflight(input("api", { env: { HOME: "/h", ANTHROPIC_AUTH_TOKEN: "tok" } }), exec)).not.toThrow();
		expect(calls).toBe(0);
	});
	it("api: refuses when no Anthropic credential is set, naming the variable and the subscription alternative", () => {
		const exec: Exec = () => status("claude.ai");
		expect(() => checkBillingPreflight(input("api", { env: { HOME: "/h" } }), exec)).toThrow(BillingPreflightError);
		expect(() => checkBillingPreflight(input("api", { env: { HOME: "/h" } }), exec)).toThrow(/ANTHROPIC_API_KEY.*--billing subscription/s);
	});

	it("subscription: refuses a third-party apiProvider even with a claude.ai login", () => {
		const exec: Exec = () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" });
		expect(() => checkBillingPreflight(input("subscription"), exec)).toThrow(/apiProvider "bedrock"/);
	});
});

describe("checkBillingPreflight — evaluator key under subscription", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const ok: Exec = () => status("claude.ai");

	it("refuses when the evaluator is anthropic and the state root has no key on disk, even though the shell has one", () => {
		root = mkdtempSync(join(tmpdir(), "eval-billing-"));
		expect(() => checkBillingPreflight(input("subscription", { evaluator: anthropicEvaluator, sourceStateRoot: root }), ok)).toThrow(BillingPreflightError);
		expect(() => checkBillingPreflight(input("subscription", { evaluator: anthropicEvaluator, sourceStateRoot: root }), ok)).toThrow(/auth\.json/);
	});
	it("passes when auth.json or .env in the state root carries the key", () => {
		root = mkdtempSync(join(tmpdir(), "eval-billing-"));
		writeFileSync(join(root, "auth.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-file" }));
		expect(() => checkBillingPreflight(input("subscription", { evaluator: anthropicEvaluator, sourceStateRoot: root }), ok)).not.toThrow();
		const other = mkdtempSync(join(tmpdir(), "eval-billing-"));
		writeFileSync(join(other, ".env"), "ANTHROPIC_API_KEY=sk-ant-dotenv\n");
		expect(() => checkBillingPreflight(input("subscription", { evaluator: anthropicEvaluator, sourceStateRoot: other }), ok)).not.toThrow();
		rmSync(other, { recursive: true, force: true });
	});
	it("checks the fallback provider too, and an empty on-disk key does not count", () => {
		root = mkdtempSync(join(tmpdir(), "eval-billing-"));
		writeFileSync(join(root, "auth.json"), JSON.stringify({ ANTHROPIC_API_KEY: "" }));
		const fallback = { provider: "ollama", model: "m", fallbackProvider: "anthropic", fallbackModel: null };
		expect(() => checkBillingPreflight(input("subscription", { evaluator: fallback, sourceStateRoot: root }), ok)).toThrow(BillingPreflightError);
	});
	it("does not apply under api billing (the key reaches the daemon through the env)", () => {
		root = mkdtempSync(join(tmpdir(), "eval-billing-"));
		expect(() => checkBillingPreflight(input("api", { evaluator: anthropicEvaluator, sourceStateRoot: root }), ok)).not.toThrow();
	});
});
