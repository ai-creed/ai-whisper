import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	getBrokerDaemonByCollab,
	insertBrokerDaemon,
} from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";
import { recordEvaluatorStatus } from "../packages/cli/src/runtime/record-evaluator-status.ts";
import type { ResolvedEvaluatorConfig } from "../packages/cli/src/runtime/evaluator-config.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "eval-status-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c1', '/r', 'a', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run();
	insertBrokerDaemon(db, {
		collabId: "c1",
		host: "127.0.0.1",
		port: 4500,
		startedAt: "2026-05-15T00:00:00Z",
		lastHeartbeatAt: "2026-05-15T00:00:00Z",
	});
	return db;
}

const withKey: ResolvedEvaluatorConfig = {
	provider: "anthropic",
	fallback: null,
	anthropic: { apiKey: "sk-test", model: null },
	ollama: { host: null, model: null },
	openai: { apiKey: null, model: null, baseURL: null },
	agentCli: { agent: null, executable: null, execArgs: null, promptVia: null, model: null },
};

const noKey: ResolvedEvaluatorConfig = {
	provider: "anthropic",
	fallback: null,
	anthropic: { apiKey: null, model: null },
	ollama: { host: null, model: null },
	openai: { apiKey: null, model: null, baseURL: null },
	agentCli: { agent: null, executable: null, execArgs: null, promptVia: null, model: null },
};

describe("recordEvaluatorStatus", () => {
	it("row starts with evaluatorStatus null before any call", () => {
		const db = freshDb();
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBeNull();
	});

	it("resolved with apiKey + orchestratorEnabled → ready; return matches persisted", () => {
		const db = freshDb();
		const returned = recordEvaluatorStatus(db, {
			collabId: "c1",
			resolved: withKey,
			loaderError: null,
			orchestratorEnabled: true,
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).not.toBeNull();
		expect(row?.evaluatorStatus).toBe("ready");
		expect(returned).toBe("ready");
		expect(returned).toBe(row?.evaluatorStatus);
	});

	it("resolved with null apiKey + orchestratorEnabled → missing_anthropic_key", () => {
		const db = freshDb();
		recordEvaluatorStatus(db, {
			collabId: "c1",
			resolved: noKey,
			loaderError: null,
			orchestratorEnabled: true,
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBe("missing_anthropic_key");
	});

	it("loaderError set + orchestratorEnabled → invalid_config", () => {
		const db = freshDb();
		recordEvaluatorStatus(db, {
			collabId: "c1",
			resolved: undefined,
			loaderError: new Error("bad config"),
			orchestratorEnabled: true,
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBe("invalid_config");
	});

	it("orchestratorEnabled false → disabled", () => {
		const db = freshDb();
		recordEvaluatorStatus(db, {
			collabId: "c1",
			resolved: withKey,
			loaderError: null,
			orchestratorEnabled: false,
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBe("disabled");
	});

	it("resolved undefined + orchestratorEnabled + no loaderError → missing_anthropic_key (NOT_CONFIGURED default)", () => {
		const db = freshDb();
		recordEvaluatorStatus(db, {
			collabId: "c1",
			resolved: undefined,
			loaderError: null,
			orchestratorEnabled: true,
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBe("missing_anthropic_key");
	});
});
