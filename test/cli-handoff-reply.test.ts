import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";
import {
	handleReplyVersionMismatch,
	resolveReplyResult,
	runHandoffReply,
} from "../packages/cli/src/commands/handoff/reply.ts";

type Reply = Parameters<typeof runHandoffReply>[0]["control"]["replyWorkflowHandoff"];

const NOW = "2026-10-23T00:00:00.000Z";
const REPLY_FAILED = (detail: string) =>
	`ai-whisper could not record your reply (${detail}). Your reply was not recorded. End your turn with your complete handback as your final message; ai-whisper will capture it. Do not read ~/.ai-whisper/state.db directly.`;
const T0 = "2026-04-21T00:00:00Z";

function deps(overrides: Record<string, unknown> = {}) {
	const replyWorkflowHandoff = vi.fn(() => ({ ok: true as const }));
	return {
		replyWorkflowHandoff,
		input: {
			control: { replyWorkflowHandoff: replyWorkflowHandoff as unknown as Reply },
			collabId: "collab_1",
			handoffId: "ho_9",
			callerAgent: "claude" as const,
			filePath: "/tmp/reply.md",
			readFile: () => "  body\n\n",
			now: NOW,
			...overrides,
		},
	};
}

async function bootWithAcceptedHandoff(sqlitePath: string) {
	const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4321 });
	broker.control.startCollab({
		collabId: "collab_c1",
		workspaceRoot: "/tmp",
		displayName: "c1",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: T0,
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: "collab_c1",
			agentType: agent,
			sessionId: `session_${agent}`,
			bindingSource: "adopted",
			now: T0,
		});
	}
	const { workflowId } = await runWorkflowStart({
		broker,
		collabId: "collab_c1",
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		implementer: "claude",
		reviewer: "codex",
		now: T0,
	});
	await new Promise((r) => setImmediate(r));
	const row = broker.control.listRelayHandoffs("collab_c1").find((r) => r.workflowId === workflowId);
	if (!row) throw new Error("no handoff");
	broker.control.acceptRelayHandoff({ handoffId: row.handoffId, acceptedAt: "2026-04-21T00:00:01Z" });
	const handoff = broker.control.getRelayHandoff(row.handoffId);
	if (!handoff) throw new Error("vanished");
	return { broker, handoff };
}

describe("runHandoffReply", () => {
	it("success passes the untrimmed body and prints confirmation", () => {
		const d = deps();
		expect(runHandoffReply(d.input)).toEqual({ exitCode: 0, stdout: "reply recorded for handoff ho_9" });
		expect(d.replyWorkflowHandoff).toHaveBeenCalledWith({
			handoffId: "ho_9",
			collabId: "collab_1",
			callerAgent: "claude",
			body: "  body\n\n",
			now: NOW,
		});
	});

	it("stores a 20KB unicode multi-line body byte-exact", async () => {
		const { broker, handoff } = await bootWithAcceptedHandoff(":memory:");
		const body = "— `code` $HOME \u001b[31mred\u001b[0m\n".repeat(500);
		const result = runHandoffReply({
			control: broker.control,
			collabId: "collab_c1",
			handoffId: handoff.handoffId,
			callerAgent: handoff.targetAgent,
			filePath: "/x",
			readFile: () => body,
			now: "2026-04-21T00:00:02Z",
		});
		expect(result.exitCode).toBe(0);
		const row = broker.db
			.prepare("SELECT handback_text FROM relay_handoff WHERE handoff_id = ?")
			.get(handoff.handoffId) as { handback_text: string };
		expect(row.handback_text).toBe(body);
		await broker.stop();
	});

	it("missing AI_WHISPER_AGENT refuses without calling the broker", () => {
		const d = deps({ callerAgent: null });
		expect(runHandoffReply(d.input)).toEqual({
			exitCode: 1,
			stdout:
				"whisper handoff reply must be run by a mounted agent (AI_WHISPER_AGENT is not set); your reply was not recorded.",
		});
		expect(d.replyWorkflowHandoff).not.toHaveBeenCalled();
	});

	it.each([
		["empty", () => ""],
		["whitespace only", () => " \n\t\n"],
		[
			"unreadable",
			() => {
				throw new Error("ENOENT");
			},
		],
	])("%s file refuses with retry copy", (_n, readFile) => {
		const d = deps({ readFile });
		expect(runHandoffReply(d.input)).toEqual({
			exitCode: 1,
			stdout:
				"reply file /tmp/reply.md is missing or empty; write your complete handback to it and run the command again.",
		});
		expect(d.replyWorkflowHandoff).not.toHaveBeenCalled();
	});

	const NR = "your reply was not recorded. Do not retry; end your turn.";
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["wrong_agent", { targetAgent: "codex" }, `handoff ho_9 is assigned to codex, not claude; ${NR}`],
		["other_collab", {}, `handoff ho_9 belongs to another collaboration; ${NR}`],
		["superseded", {}, `handoff ho_9 is no longer the current handoff for its workflow; ${NR}`],
		["not_workflow", {}, `handoff ho_9 is not a workflow handoff; ${NR}`],
		["not_accepted", { status: "pending" }, `handoff ho_9 is pending; ${NR}`],
		["not_accepted", { status: "handed_back", capturePath: null }, `handoff ho_9 is handed_back; ${NR}`],
		[
			"not_accepted",
			{ status: "handed_back", capturePath: "reply" },
			"handoff ho_9 is already handed back; your earlier reply stands. Do not retry; end your turn.",
		],
		["unknown", {}, `handoff ho_9 is unknown; ${NR}`],
	];
	it.each(cases)("broker refusal %s prints its copy and exits 1", (reason, extra, copy) => {
		const d = deps();
		d.replyWorkflowHandoff.mockReturnValue({ ok: false, reason, ...extra } as never);
		expect(runHandoffReply(d.input)).toEqual({ exitCode: 1, stdout: copy });
	});
});

describe("handleReplyVersionMismatch", () => {
	it("records reply_refused_at, prints the message, and does not migrate", async () => {
		const sqlitePath = join(mkdtempSync(join(tmpdir(), "hr-")), "b.sqlite");
		const { broker, handoff } = await bootWithAcceptedHandoff(sqlitePath);
		await broker.stop();
		const db = openDatabase(sqlitePath);
		const before = {
			v: db.pragma("user_version", { simple: true }),
			t: db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),
		};
		const result = handleReplyVersionMismatch({
			db,
			collabId: "collab_c1",
			handoffId: handoff.handoffId,
			message: "MISMATCH COPY",
			now: "2026-04-21T00:00:09Z",
		});
		expect(result).toEqual({ exitCode: 1, stdout: "MISMATCH COPY" });
		const row = db
			.prepare("SELECT reply_refused_at FROM relay_handoff WHERE handoff_id = ?")
			.get(handoff.handoffId) as { reply_refused_at: string | null };
		expect(row.reply_refused_at).toBe("2026-04-21T00:00:09Z");
		expect({
			v: db.pragma("user_version", { simple: true }),
			t: db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),
		}).toEqual(before);
		db.close();
	});
});

describe("resolveReplyResult", () => {
	it("null agent plus version mismatch refuses without connecting or recording", async () => {
		const sqlitePath = join(mkdtempSync(join(tmpdir(), "hr-")), "b.sqlite");
		const { broker, handoff } = await bootWithAcceptedHandoff(sqlitePath);
		await broker.stop();
		const db = openDatabase(sqlitePath);
		const close = vi.fn();
		const connect = vi.fn(() => ({
			ok: false as const,
			reason: "version_mismatch" as const,
			collabId: "collab_c1",
			db,
			message: "MISMATCH COPY",
			close,
		}));
		const result = resolveReplyResult({
			callerAgent: null,
			connect,
			handoffId: handoff.handoffId,
			filePath: "/x",
			readFile: () => "body",
			now: "2026-04-21T00:00:09Z",
		});
		expect(result).toEqual({
			exitCode: 1,
			stdout:
				"whisper handoff reply must be run by a mounted agent (AI_WHISPER_AGENT is not set); your reply was not recorded.",
		});
		const row = db
			.prepare("SELECT reply_refused_at FROM relay_handoff WHERE handoff_id = ?")
			.get(handoff.handoffId) as { reply_refused_at: string | null };
		expect(row.reply_refused_at).toBeNull();
		db.close();
	});

	it("known agent plus version mismatch records the refusal and closes", async () => {
		const sqlitePath = join(mkdtempSync(join(tmpdir(), "hr-")), "b.sqlite");
		const { broker, handoff } = await bootWithAcceptedHandoff(sqlitePath);
		await broker.stop();
		const db = openDatabase(sqlitePath);
		const close = vi.fn();
		const result = resolveReplyResult({
			callerAgent: "claude",
			connect: () => ({
				ok: false,
				reason: "version_mismatch",
				collabId: "collab_c1",
				db,
				message: "MISMATCH COPY",
				close,
			}),
			handoffId: handoff.handoffId,
			filePath: "/x",
			readFile: () => "body",
			now: "2026-04-21T00:00:09Z",
		});
		expect(result).toEqual({ exitCode: 1, stdout: "MISMATCH COPY" });
		expect(close).toHaveBeenCalledTimes(1);
		const row = db
			.prepare("SELECT reply_refused_at FROM relay_handoff WHERE handoff_id = ?")
			.get(handoff.handoffId) as { reply_refused_at: string | null };
		expect(row.reply_refused_at).toBe("2026-04-21T00:00:09Z");
		db.close();
	});

	it("resolver failure prints reply guidance without recording", () => {
		const close = vi.fn();
		const result = resolveReplyResult({
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
			filePath: "/x",
			readFile: () => "body",
			now: NOW,
		});
		expect(result).toEqual({ exitCode: 1, stdout: REPLY_FAILED("no active collab found for cwd /x") });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a throw inside the body prints reply guidance, exits 1 and closes", () => {
		const close = vi.fn();
		const result = resolveReplyResult({
			callerAgent: "claude",
			connect: () => ({
				ok: true,
				collabId: "collab_1",
				control: {
					replyWorkflowHandoff: () => {
						throw new Error("SQLITE_BUSY: database is locked");
					},
				} as never,
				close,
			}),
			handoffId: "ho_1",
			filePath: "/x",
			readFile: () => "body",
			now: NOW,
		});
		expect(result).toEqual({ exitCode: 1, stdout: REPLY_FAILED("SQLITE_BUSY: database is locked") });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a throw from connect prints reply guidance", () => {
		const result = resolveReplyResult({
			callerAgent: "claude",
			connect: () => {
				throw new Error("unable to open database file");
			},
			handoffId: "ho_1",
			filePath: "/x",
			readFile: () => "body",
			now: NOW,
		});
		expect(result).toEqual({ exitCode: 1, stdout: REPLY_FAILED("unable to open database file") });
	});

	it("mismatch still prints the mismatch copy when recording the refusal throws", () => {
		const sqlitePath = join(mkdtempSync(join(tmpdir(), "hr-")), "b.sqlite");
		const db = openDatabase(sqlitePath);
		db.close(); // any prepare() on a closed handle throws
		const close = vi.fn();
		const result = resolveReplyResult({
			callerAgent: "claude",
			connect: () => ({
				ok: false,
				reason: "version_mismatch",
				collabId: "collab_c1",
				db,
				message: "MISMATCH COPY",
				close,
			}),
			handoffId: "ho_1",
			filePath: "/x",
			readFile: () => "body",
			now: NOW,
		});
		expect(result).toEqual({ exitCode: 1, stdout: "MISMATCH COPY" });
		expect(close).toHaveBeenCalledTimes(1);
	});
});
