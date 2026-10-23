import { describe, expect, it, vi } from "vitest";
import { runHandoffShow } from "../packages/cli/src/commands/handoff/show.ts";

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
		});
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
