import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURRENT_SCHEMA_VERSION,
	EVENT_PROTOCOL_VERSION,
} from "@ai-whisper/broker";
import {
	buildEnvReport,
	renderEnvReportText,
} from "../packages/cli/src/commands/env/report.ts";
import { resolveCliVersion } from "../packages/cli/src/runtime/cli-package-info.ts";
import { createCli } from "../packages/cli/src/create-cli.ts";

const STATE_ROOT_KEY = "AI_WHISPER_STATE_ROOT";

// Evaluator-config env vars that loadEvaluatorConfig reads at the highest
// precedence. They must be cleared in tests that exercise the evaluator field,
// otherwise an exported key in the dev/CI environment makes the result
// non-deterministic.
const EVALUATOR_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"AI_WHISPER_EVALUATOR_PROVIDER",
	"AI_WHISPER_EVALUATOR_FALLBACK",
	"AI_WHISPER_EVALUATOR_OLLAMA_HOST",
	"AI_WHISPER_EVALUATOR_OLLAMA_MODEL",
	"OPENAI_API_KEY",
	"AI_WHISPER_EVALUATOR_OPENAI_MODEL",
	"AI_WHISPER_EVALUATOR_OPENAI_BASE_URL",
	"AI_WHISPER_EVALUATOR_AGENT_CLI_AGENT",
];

describe("buildEnvReport", () => {
	// buildEnvReport now reads the evaluator config (auth.json/config.json/.env +
	// env vars) under getStateRoot(). Point the state root at a fresh empty temp
	// dir and clear the evaluator env vars so each case starts from a known,
	// credential-free baseline.
	let root: string;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const k of [STATE_ROOT_KEY, ...EVALUATOR_ENV_KEYS]) {
			savedEnv.set(k, process.env[k]);
			delete process.env[k];
		}
		root = mkdtempSync(join(tmpdir(), "whisper-env-report-"));
		process.env[STATE_ROOT_KEY] = root;
	});

	afterEach(() => {
		for (const [k, v] of savedEnv) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		savedEnv.clear();
		rmSync(root, { recursive: true, force: true });
	});

	it("returns the contractual fields plus an evaluator block with correct types", () => {
		const r = buildEnvReport();
		expect(Object.keys(r).sort()).toEqual([
			"dbSchemaVersion",
			"engineVersion",
			"evaluator",
			"installPath",
			"protocolVersion",
			"stateRoot",
		]);
		expect(typeof r.engineVersion).toBe("string");
		expect(typeof r.installPath).toBe("string");
		expect(typeof r.stateRoot).toBe("string");
		expect(typeof r.dbSchemaVersion).toBe("number");
		expect(typeof r.protocolVersion).toBe("string");
		expect(typeof r.evaluator.status).toBe("string");
		expect(typeof r.evaluator.ready).toBe("boolean");
	});

	it("sources version, schema and protocol from the single-source constants", () => {
		const r = buildEnvReport();
		expect(r.engineVersion).toBe(resolveCliVersion());
		expect(r.dbSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(r.protocolVersion).toBe(EVENT_PROTOCOL_VERSION);
	});

	it("honors AI_WHISPER_STATE_ROOT for stateRoot", () => {
		expect(buildEnvReport().stateRoot).toBe(root);
	});

	it("reports missing_anthropic_key (not ready) when no credentials are configured", () => {
		const r = buildEnvReport();
		expect(r.evaluator).toEqual({
			status: "missing_anthropic_key",
			ready: false,
		});
	});

	it("reports ready when an Anthropic key is present in auth.json", () => {
		const authPath = join(root, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-test" }),
		);
		chmodSync(authPath, 0o600); // silence the secret-file perms warning
		expect(buildEnvReport().evaluator).toEqual({
			status: "ready",
			ready: true,
		});
	});

	it("reports ready for the ollama provider, which needs no Anthropic key", () => {
		writeFileSync(
			join(root, "config.json"),
			JSON.stringify({ evaluator: { provider: "ollama" } }),
		);
		expect(buildEnvReport().evaluator).toEqual({
			status: "ready",
			ready: true,
		});
	});

	it("reports invalid_config (not ready) when a config file is malformed", () => {
		writeFileSync(join(root, "auth.json"), "{ not valid json");
		expect(buildEnvReport().evaluator).toEqual({
			status: "invalid_config",
			ready: false,
		});
	});

	it("reports missing_openai_key when provider=openai has no key", () => {
		writeFileSync(join(root, "config.json"), JSON.stringify({ evaluator: { provider: "openai", openai: { model: "gpt-4o-mini" } } }));
		expect(buildEnvReport().evaluator).toEqual({ status: "missing_openai_key", ready: false });
	});

	it("reports invalid_config when provider=openai has a key but no model", () => {
		const authPath = join(root, "auth.json");
		writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
		chmodSync(authPath, 0o600);
		writeFileSync(join(root, "config.json"), JSON.stringify({ evaluator: { provider: "openai" } }));
		expect(buildEnvReport().evaluator).toEqual({ status: "invalid_config", ready: false });
	});

	it("reports agent_cli_unavailable when the configured executable is absent", () => {
		// Absolute path that does not exist → the REAL isExecutableOnPath returns false
		// deterministically (no $PATH dependence), so buildEnvReport's daemon-free check is exercised end-to-end.
		writeFileSync(join(root, "config.json"), JSON.stringify({ evaluator: { provider: "agent-cli", agentCli: { agent: "claude", executable: "/nonexistent/aiw-no-such-cli" } } }));
		expect(buildEnvReport().evaluator).toEqual({ status: "agent_cli_unavailable", ready: false });
	});

	it("reports invalid_config when provider=agent-cli has no agent", () => {
		writeFileSync(join(root, "config.json"), JSON.stringify({ evaluator: { provider: "agent-cli" } }));
		expect(buildEnvReport().evaluator).toEqual({ status: "invalid_config", ready: false });
	});

	it("renderEnvReportText prints one labeled line per field, including evaluator", () => {
		const text = renderEnvReportText(buildEnvReport());
		expect(text).toContain("engineVersion:");
		expect(text).toContain("protocolVersion:");
		expect(text).toContain("evaluator:");
		expect(text.split("\n")).toHaveLength(6);
	});
});

describe("whisper env --json (pure stdout)", () => {
	let logs: string[];
	let spy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		logs = [];
		spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
			logs.push(String(m));
		});
	});
	afterEach(() => spy.mockRestore());

	it("emits exactly one JSON object and nothing else", async () => {
		await createCli().parseAsync(["env", "--json"], { from: "user" });
		expect(logs).toHaveLength(1);
		const parsed = JSON.parse(logs[0]!) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			engineVersion: expect.any(String),
			installPath: expect.any(String),
			stateRoot: expect.any(String),
			dbSchemaVersion: expect.any(Number),
			protocolVersion: EVENT_PROTOCOL_VERSION,
			evaluator: {
				status: expect.any(String),
				ready: expect.any(Boolean),
			},
		});
	});

	it("without --json prints a human rendering (non-JSON)", async () => {
		await createCli().parseAsync(["env"], { from: "user" });
		expect(logs).toHaveLength(1);
		expect(() => {
			JSON.parse(logs[0]!);
		}).toThrow();
		expect(logs[0]).toContain("engineVersion:");
	});
});
