import { describe, expect, it } from "vitest";
import {
	createBrokerRuntime,
	getHandsOffStats,
	type HandsOffStats,
} from "../packages/broker/src/index.ts";

function bootstrap() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4399,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	const db = broker.db;
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
		 VALUES ('c1','/tmp','c1','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
	).run();
	db.prepare(
		`INSERT INTO workflows
		   (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings,
		    status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
		 VALUES ('wf1','c1','spec-driven-development',NULL,'/s','{}','done',0,NULL,'{}',
		         '2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`,
	).run();
	return broker;
}

describe("broker control: getHandsOffStats", () => {
	it("exposes getHandsOffStats on the control object", () => {
		const broker = bootstrap();
		const stats: HandsOffStats = broker.control.getHandsOffStats();
		expect(stats.totalMs).toBe(3_600_000); // 1h
		expect(stats.count).toBe(1);
		expect(stats.byStatus.done.count).toBe(1);
	});

	it("re-exports the standalone getHandsOffStats from the package root", () => {
		const broker = bootstrap();
		expect(getHandsOffStats(broker.db).totalMs).toBe(3_600_000);
	});
});
