import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadEvaluatorConfig,
	computeEvaluatorStatus,
	isEvaluatorReady,
	isEvaluatorPreflightBlocked,
} from "../packages/cli/src/runtime/evaluator-config.ts";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "aiw-evalcfg-"));
}

describe("loadEvaluatorConfig precedence", () => {
	let root: string;
	let prevRoot: string | undefined;
	let prevKey: string | undefined;
	let prevProvider: string | undefined;
	let prevFallback: string | undefined;
	let prevOllamaHost: string | undefined;
	let prevOllamaModel: string | undefined;
	let prevOpenaiKey: string | undefined;
	let prevOpenaiModel: string | undefined;
	let prevOpenaiBaseUrl: string | undefined;

	beforeEach(() => {
		root = tmpRoot();
		prevRoot = process.env.AI_WHISPER_STATE_ROOT;
		prevKey = process.env.ANTHROPIC_API_KEY;
		prevProvider = process.env.AI_WHISPER_EVALUATOR_PROVIDER;
		prevFallback = process.env.AI_WHISPER_EVALUATOR_FALLBACK;
		prevOllamaHost = process.env.AI_WHISPER_EVALUATOR_OLLAMA_HOST;
		prevOllamaModel = process.env.AI_WHISPER_EVALUATOR_OLLAMA_MODEL;
		prevOpenaiKey = process.env.OPENAI_API_KEY;
		prevOpenaiModel = process.env.AI_WHISPER_EVALUATOR_OPENAI_MODEL;
		prevOpenaiBaseUrl = process.env.AI_WHISPER_EVALUATOR_OPENAI_BASE_URL;
		process.env.AI_WHISPER_STATE_ROOT = root;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.AI_WHISPER_EVALUATOR_PROVIDER;
		delete process.env.AI_WHISPER_EVALUATOR_FALLBACK;
		delete process.env.AI_WHISPER_EVALUATOR_OLLAMA_HOST;
		delete process.env.AI_WHISPER_EVALUATOR_OLLAMA_MODEL;
		delete process.env.OPENAI_API_KEY;
		delete process.env.AI_WHISPER_EVALUATOR_OPENAI_MODEL;
		delete process.env.AI_WHISPER_EVALUATOR_OPENAI_BASE_URL;
	});
	afterEach(() => {
		const restore = (k: string, v: string | undefined) =>
			v === undefined ? delete process.env[k] : (process.env[k] = v);
		restore("AI_WHISPER_STATE_ROOT", prevRoot);
		restore("ANTHROPIC_API_KEY", prevKey);
		restore("AI_WHISPER_EVALUATOR_PROVIDER", prevProvider);
		restore("AI_WHISPER_EVALUATOR_FALLBACK", prevFallback);
		restore("AI_WHISPER_EVALUATOR_OLLAMA_HOST", prevOllamaHost);
		restore("AI_WHISPER_EVALUATOR_OLLAMA_MODEL", prevOllamaModel);
		restore("OPENAI_API_KEY", prevOpenaiKey);
		restore("AI_WHISPER_EVALUATOR_OPENAI_MODEL", prevOpenaiModel);
		restore("AI_WHISPER_EVALUATOR_OPENAI_BASE_URL", prevOpenaiBaseUrl);
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults when nothing is configured (apiKey null)", () => {
		const cfg = loadEvaluatorConfig();
		expect(cfg.provider).toBe("anthropic");
		expect(cfg.fallback).toBeNull();
		expect(cfg.anthropic.apiKey).toBeNull();
	});

	it("auth.json supplies the key; config.json supplies settings", () => {
		writeFileSync(join(root, "auth.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-file" }), { mode: 0o600 });
		writeFileSync(join(root, "config.json"), JSON.stringify({
			evaluator: { provider: "anthropic", fallback: "ollama", anthropicModel: "claude-x", ollama: { host: "http://h", model: "m" } },
		}));
		const cfg = loadEvaluatorConfig();
		expect(cfg.anthropic.apiKey).toBe("sk-file");
		expect(cfg.fallback).toBe("ollama");
		expect(cfg.anthropic.model).toBe("claude-x");
		expect(cfg.ollama).toMatchObject({ host: "http://h", model: "m" });
	});

	it(".env overrides the JSON files", () => {
		writeFileSync(join(root, "auth.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-file" }), { mode: 0o600 });
		writeFileSync(join(root, ".env"), 'ANTHROPIC_API_KEY="sk-dotenv"\n# comment\n');
		expect(loadEvaluatorConfig().anthropic.apiKey).toBe("sk-dotenv");
	});

	it("exported process env beats .env and files", () => {
		writeFileSync(join(root, "auth.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-file" }), { mode: 0o600 });
		writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=sk-dotenv\n");
		process.env.ANTHROPIC_API_KEY = "sk-env";
		expect(loadEvaluatorConfig().anthropic.apiKey).toBe("sk-env");
	});

	it("malformed config.json throws with the filename", () => {
		writeFileSync(join(root, "config.json"), "{ not json");
		expect(() => loadEvaluatorConfig()).toThrow(/config\.json/);
	});

	it("malformed auth.json throws with the filename", () => {
		writeFileSync(join(root, "auth.json"), "{ not json", { mode: 0o600 });
		expect(() => loadEvaluatorConfig()).toThrow(/auth\.json/);
	});

	it("a bad .env line is skipped, not fatal", () => {
		writeFileSync(join(root, ".env"), "this is not key=value-ish at all\nANTHROPIC_API_KEY=sk-ok\n");
		expect(loadEvaluatorConfig().anthropic.apiKey).toBe("sk-ok");
	});

	it("warns (does not throw) when auth.json is group/world-readable", () => {
		if (process.platform === "win32") return; // perms bits not meaningful
		const authPath = join(root, "auth.json");
		writeFileSync(authPath, JSON.stringify({ ANTHROPIC_API_KEY: "sk-file" }), { mode: 0o600 });
		chmodSync(authPath, 0o644); // loosen after write (umask-independent)
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const cfg = loadEvaluatorConfig();
		expect(cfg.anthropic.apiKey).toBe("sk-file"); // still loads
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/chmod 600/));
		warn.mockRestore();
	});

	it("does NOT warn when auth.json is 0600", () => {
		if (process.platform === "win32") return;
		const authPath = join(root, "auth.json");
		writeFileSync(authPath, JSON.stringify({ ANTHROPIC_API_KEY: "sk-file" }), { mode: 0o600 });
		chmodSync(authPath, 0o600);
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		loadEvaluatorConfig();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	describe("openai provider resolution + status", () => {
		it("resolves openai key/model/baseURL with env > auth > config precedence", () => {
			writeFileSync(join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-auth" }), { mode: 0o600 });
			writeFileSync(join(root, "config.json"), JSON.stringify({ evaluator: { provider: "openai", openai: { model: "cfg-model", baseURL: "https://cfg/v1" } } }));
			process.env.AI_WHISPER_EVALUATOR_OPENAI_MODEL = "env-model";
			const cfg = loadEvaluatorConfig();
			expect(cfg.provider).toBe("openai");
			expect(cfg.openai.apiKey).toBe("sk-auth");
			expect(cfg.openai.model).toBe("env-model");           // env beats config
			expect(cfg.openai.baseURL).toBe("https://cfg/v1");
		});

		it("missing key → missing_openai_key; missing model → invalid_config", () => {
			const noKey = { provider: "openai" as const, fallback: null, anthropic: { apiKey: null, model: null }, ollama: { host: null, model: null }, openai: { apiKey: null, model: "m", baseURL: null }, agentCli: { agent: null, executable: null, execArgs: null, promptVia: null, model: null } };
			expect(computeEvaluatorStatus(noKey, { orchestratorEnabled: true, loaderError: null })).toBe("missing_openai_key");
			const noModel = { ...noKey, openai: { apiKey: "k", model: null, baseURL: null } };
			expect(computeEvaluatorStatus(noModel, { orchestratorEnabled: true, loaderError: null })).toBe("invalid_config");
			const ready = { ...noKey, openai: { apiKey: "k", model: "m", baseURL: null } };
			expect(computeEvaluatorStatus(ready, { orchestratorEnabled: true, loaderError: null })).toBe("ready");
		});

		it("missing_openai_key and is preflight-blocked", () => {
			expect(isEvaluatorPreflightBlocked("missing_openai_key")).toBe(true);
		});
	});
});

describe("computeEvaluatorStatus", () => {
	const base = { provider: "anthropic" as const, fallback: null, anthropic: { apiKey: "sk", model: null }, ollama: { host: null, model: null }, openai: { apiKey: null, model: null, baseURL: null }, agentCli: { agent: null, executable: null, execArgs: null, promptVia: null, model: null } };
	it("orchestrator off → disabled", () => {
		expect(computeEvaluatorStatus(base, { orchestratorEnabled: false, loaderError: null })).toBe("disabled");
	});
	it("loader error → invalid_config", () => {
		expect(computeEvaluatorStatus(base, { orchestratorEnabled: true, loaderError: new Error("bad") })).toBe("invalid_config");
	});
	it("anthropic + key → ready", () => {
		expect(computeEvaluatorStatus(base, { orchestratorEnabled: true, loaderError: null })).toBe("ready");
	});
	it("anthropic + no key → missing_anthropic_key", () => {
		expect(computeEvaluatorStatus({ ...base, anthropic: { apiKey: null, model: null } }, { orchestratorEnabled: true, loaderError: null })).toBe("missing_anthropic_key");
	});
	it("ollama → ready regardless of anthropic key", () => {
		expect(computeEvaluatorStatus({ ...base, provider: "ollama", anthropic: { apiKey: null, model: null } }, { orchestratorEnabled: true, loaderError: null })).toBe("ready");
	});
});

describe("isEvaluatorReady", () => {
	it("ready → true", () => {
		expect(isEvaluatorReady("ready")).toBe(true);
	});
	it("unknown → true (fail-open for pre-migration daemons)", () => {
		expect(isEvaluatorReady("unknown")).toBe(true);
	});
	it("missing_anthropic_key → false", () => {
		expect(isEvaluatorReady("missing_anthropic_key")).toBe(false);
	});
	it("invalid_config → false", () => {
		expect(isEvaluatorReady("invalid_config")).toBe(false);
	});
	it("disabled → false", () => {
		expect(isEvaluatorReady("disabled")).toBe(false);
	});
});

describe("isEvaluatorPreflightBlocked", () => {
	it("missing_anthropic_key → true", () => {
		expect(isEvaluatorPreflightBlocked("missing_anthropic_key")).toBe(true);
	});
	it("invalid_config → true", () => {
		expect(isEvaluatorPreflightBlocked("invalid_config")).toBe(true);
	});
	it("ready → false", () => {
		expect(isEvaluatorPreflightBlocked("ready")).toBe(false);
	});
	it("unknown → false", () => {
		expect(isEvaluatorPreflightBlocked("unknown")).toBe(false);
	});
	it("disabled → false", () => {
		expect(isEvaluatorPreflightBlocked("disabled")).toBe(false);
	});
});
