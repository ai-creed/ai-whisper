import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION, EVENT_PROTOCOL_VERSION } from "@ai-whisper/broker";
import {
	buildEnvReport,
	renderEnvReportText,
} from "../packages/cli/src/commands/env/report.ts";
import { resolveCliVersion } from "../packages/cli/src/runtime/cli-package-info.ts";
import { createCli } from "../packages/cli/src/create-cli.ts";

const STATE_ROOT_KEY = "AI_WHISPER_STATE_ROOT";

describe("buildEnvReport", () => {
	const prior = process.env[STATE_ROOT_KEY];
	afterEach(() => {
		if (prior === undefined) delete process.env[STATE_ROOT_KEY];
		else process.env[STATE_ROOT_KEY] = prior;
	});

	it("returns exactly the five contractual fields with correct types", () => {
		const r = buildEnvReport();
		expect(Object.keys(r).sort()).toEqual([
			"dbSchemaVersion",
			"engineVersion",
			"installPath",
			"protocolVersion",
			"stateRoot",
		]);
		expect(typeof r.engineVersion).toBe("string");
		expect(typeof r.installPath).toBe("string");
		expect(typeof r.stateRoot).toBe("string");
		expect(typeof r.dbSchemaVersion).toBe("number");
		expect(typeof r.protocolVersion).toBe("string");
	});

	it("sources version, schema and protocol from the single-source constants", () => {
		const r = buildEnvReport();
		expect(r.engineVersion).toBe(resolveCliVersion());
		expect(r.dbSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(r.protocolVersion).toBe(EVENT_PROTOCOL_VERSION);
	});

	it("honors AI_WHISPER_STATE_ROOT for stateRoot", () => {
		process.env[STATE_ROOT_KEY] = "/tmp/whisper-env-test-root";
		expect(buildEnvReport().stateRoot).toBe("/tmp/whisper-env-test-root");
	});

	it("renderEnvReportText prints one labeled line per field", () => {
		const text = renderEnvReportText(buildEnvReport());
		expect(text).toContain("engineVersion:");
		expect(text).toContain("protocolVersion:");
		expect(text.split("\n")).toHaveLength(5);
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
		});
	});

	it("without --json prints a human rendering (non-JSON)", async () => {
		await createCli().parseAsync(["env"], { from: "user" });
		expect(logs).toHaveLength(1);
		expect(() => JSON.parse(logs[0]!)).toThrow();
		expect(logs[0]).toContain("engineVersion:");
	});
});
