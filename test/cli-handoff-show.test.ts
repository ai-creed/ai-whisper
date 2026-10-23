import { describe, expect, it, vi } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { getNoticePathFields } from "../packages/broker/src/storage/repositories/notice-path-repository.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";
import { resolveShowResult, runHandoffShow } from "../packages/cli/src/commands/handoff/show.ts";

type Fetch = Parameters<typeof runHandoffShow>[0]["control"]["fetchWorkflowHandoff"];

const NOW = "2026-10-23T00:00:00.000Z";

function okHandoff(overrides: Record<string, unknown> = {}) {
	return {
		ok: true as const,
		handoff: {
			handoffId: "ho_1",
			workflowId: "wf_1",
			phaseName: "plan-execution",
			handoffStep: "implement",
			roundNumber: 2,
			senderAgent: "codex" as const,
			targetAgent: "claude" as const,
			requestText: "Line one\n\nUse `pnpm test` here.\n",
			...overrides,
		},
	};
}

describe("runHandoffShow", () => {
	it("prints header, meta line, verbatim request and footer", () => {
		const fetchWorkflowHandoff = vi.fn(() => okHandoff()) as unknown as Fetch;
		const result = runHandoffShow({
			control: { fetchWorkflowHandoff },
			collabId: "collab_1",
			handoffId: "ho_1",
			callerAgent: "claude",
			now: NOW,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(
			[
				"=== ai-whisper handoff ho_1 — operator request, delivered by ai-whisper on the operator's behalf ===",
				"workflow wf_1 · phase plan-execution · step implement · round 2 · from: codex · to: claude",
				"",
				"Line one\n\nUse `pnpm test` here.\n",
				"",
				"=== end of handoff ho_1 ===",
			].join("\n"),
		);
	});

	it("uses - for null phase, step and round", () => {
		const fetchWorkflowHandoff = vi.fn(() =>
			okHandoff({ phaseName: null, handoffStep: null, roundNumber: null }),
		) as unknown as Fetch;
		const result = runHandoffShow({
			control: { fetchWorkflowHandoff },
			collabId: "collab_1",
			handoffId: "ho_1",
			callerAgent: null,
			now: NOW,
		});
		expect(result.stdout.split("\n")[1]).toBe(
			"workflow wf_1 · phase - · step - · round - · from: codex · to: claude",
		);
	});

	it("passes the resolved collabId to fetchWorkflowHandoff", () => {
		const fetchWorkflowHandoff = vi.fn(() => okHandoff());
		runHandoffShow({
			control: { fetchWorkflowHandoff: fetchWorkflowHandoff as unknown as Fetch },
			collabId: "collab_xyz",
			handoffId: "ho_1",
			callerAgent: "claude",
			now: NOW,
		});
		expect(fetchWorkflowHandoff).toHaveBeenCalledWith({
			handoffId: "ho_1",
			collabId: "collab_xyz",
			callerAgent: "claude",
			now: NOW,
			record: true,
		});
	});

	it("a null caller peeks: the fetch is not recorded", () => {
		const fetchWorkflowHandoff = vi.fn(() => okHandoff());
		const result = runHandoffShow({
			control: { fetchWorkflowHandoff: fetchWorkflowHandoff as unknown as Fetch },
			collabId: "collab_xyz",
			handoffId: "ho_1",
			callerAgent: null,
			now: NOW,
		});
		expect(result.exitCode).toBe(0);
		expect(fetchWorkflowHandoff).toHaveBeenCalledWith(expect.objectContaining({ record: false }));
	});

	const cases: Array<[string, Record<string, unknown>, string]> = [
		["unknown", {}, "unknown handoff ho_9. Do not act on it; end your turn."],
		["other_collab", {}, "handoff ho_9 belongs to another collaboration. Do not act on it; end your turn."],
		["not_workflow", {}, "handoff ho_9 is not a workflow handoff. Do not act on it; end your turn."],
		["not_accepted", { status: "pending" }, "handoff ho_9 is pending, not awaiting your work. Do not act on it; end your turn."],
		["superseded", {}, "handoff ho_9 is no longer the current handoff for its workflow. Do not act on it; end your turn."],
		["wrong_agent", { targetAgent: "codex" }, "handoff ho_9 is assigned to codex, not claude. Do not act on it; end your turn."],
	];
	it.each(cases)("refusal %s prints its copy and exits 1", (reason, extra, copy) => {
		const fetchWorkflowHandoff = vi.fn(() => ({ ok: false, reason, ...extra })) as unknown as Fetch;
		const result = runHandoffShow({
			control: { fetchWorkflowHandoff },
			collabId: "collab_1",
			handoffId: "ho_9",
			callerAgent: "claude",
			now: NOW,
		});
		expect(result).toEqual({ exitCode: 1, stdout: copy });
	});
});

const UNREACHABLE = (detail: string) =>
	`ai-whisper could not reach the broker for this workspace (${detail}). Stop here and end your turn; do not read ~/.ai-whisper/state.db directly.`;

function okConn(fetchWorkflowHandoff: unknown, close = vi.fn()) {
	return {
		close,
		conn: {
			ok: true as const,
			collabId: "collab_1",
			control: { fetchWorkflowHandoff } as never,
			close,
		},
	};
}

describe("resolveShowResult", () => {
	it("null caller still connects and prints the handoff, then closes", () => {
		const fetchWorkflowHandoff = vi.fn(() => okHandoff());
		const { conn, close } = okConn(fetchWorkflowHandoff);
		const r = resolveShowResult({ callerAgent: null, connect: () => conn, handoffId: "ho_1", now: NOW });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("=== end of handoff ho_1 ===");
		expect(fetchWorkflowHandoff).toHaveBeenCalledWith(expect.objectContaining({ record: false }));
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("version mismatch prints the mismatch copy, skips the body and closes", () => {
		const close = vi.fn();
		const fetchWorkflowHandoff = vi.fn();
		const r = resolveShowResult({
			callerAgent: "claude",
			connect: () => ({
				ok: false,
				reason: "version_mismatch",
				collabId: "c1",
				db: {} as never,
				message: "MISMATCH COPY",
				close,
			}),
			handoffId: "ho_1",
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: "MISMATCH COPY" });
		expect(fetchWorkflowHandoff).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("resolver failure prints guidance and closes", () => {
		const close = vi.fn();
		const r = resolveShowResult({
			callerAgent: "claude",
			connect: () => ({
				ok: false,
				reason: "unresolved",
				collabId: null,
				db: null,
				message: "no active collab found for cwd /x",
				close,
			}),
			handoffId: "ho_1",
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: UNREACHABLE("no active collab found for cwd /x") });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a throw inside the body prints guidance, exits 1 and closes", () => {
		const { conn, close } = okConn(
			vi.fn(() => {
				throw new Error("SQLITE_BUSY: database is locked\n    at x");
			}),
		);
		const r = resolveShowResult({ callerAgent: "claude", connect: () => conn, handoffId: "ho_1", now: NOW });
		expect(r).toEqual({ exitCode: 1, stdout: UNREACHABLE("SQLITE_BUSY: database is locked at x") });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a throw from connect (e.g. openDatabase) prints guidance", () => {
		const r = resolveShowResult({
			callerAgent: "claude",
			connect: () => {
				throw new Error("unable to open database file");
			},
			handoffId: "ho_1",
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: UNREACHABLE("unable to open database file") });
	});
});

describe("runHandoffShow against a real broker", () => {
	async function boot() {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
		broker.control.startCollab({
			collabId: "collab_c1",
			workspaceRoot: "/tmp",
			displayName: "c1",
			orchestratorEnabled: true,
			orchestratorMaxRounds: 3,
			now: "2026-04-21T00:00:00Z",
		});
		for (const agent of ["claude", "codex"] as const) {
			broker.control.setSessionBinding({
				collabId: "collab_c1",
				agentType: agent,
				sessionId: `session_${agent}`,
				bindingSource: "adopted",
				now: "2026-04-21T00:00:00Z",
			});
		}
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		const row = broker.control.listRelayHandoffs("collab_c1").find((r) => r.workflowId === workflowId);
		if (!row) throw new Error("no handoff");
		broker.control.acceptRelayHandoff({ handoffId: row.handoffId, acceptedAt: "2026-04-21T00:00:01Z" });
		const handoff = broker.control.getRelayHandoff(row.handoffId);
		if (!handoff) throw new Error("vanished");
		return { broker, handoff };
	}

	it("null caller prints the full handoff without recording; a known agent records", async () => {
		const { broker, handoff } = await boot();
		const peek = runHandoffShow({
			control: broker.control,
			collabId: "collab_c1",
			handoffId: handoff.handoffId,
			callerAgent: null,
			now: "2026-04-21T00:00:02Z",
		});
		expect(peek.exitCode).toBe(0);
		expect(peek.stdout).toContain(handoff.requestText);
		expect(peek.stdout).toContain(`=== end of handoff ${handoff.handoffId} ===`);
		let fields = getNoticePathFields(broker.db, handoff.handoffId);
		expect(fields?.fetchedAt).toBeNull();
		expect(fields?.fetchCount).toBe(0);

		const real = runHandoffShow({
			control: broker.control,
			collabId: "collab_c1",
			handoffId: handoff.handoffId,
			callerAgent: handoff.targetAgent,
			now: "2026-04-21T00:00:03Z",
		});
		expect(real.exitCode).toBe(0);
		fields = getNoticePathFields(broker.db, handoff.handoffId);
		expect(fields?.fetchedAt).toBe("2026-04-21T00:00:03Z");
		expect(fields?.fetchCount).toBe(1);
		await broker.stop();
	});
});
