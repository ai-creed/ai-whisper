import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { withHandbackFragment } from "../packages/broker/src/control/handback-fragment.ts";

const COLLAB_ID = "collab_c1";

function setup() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	broker.control.startCollab({
		collabId: COLLAB_ID,
		workspaceRoot: "/tmp",
		displayName: "c1",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: "2026-04-21T00:00:00Z",
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: COLLAB_ID,
			agentType: agent,
			sessionId: `session_${agent}`,
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	const { workflowId } = broker.control.createWorkflow({
		collabId: COLLAB_ID,
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now: "2026-04-21T00:00:00Z",
	});
	const { handoffId } = broker.control.beginPhaseRun({
		workflowId,
		phaseIndex: 0,
		phaseName: "spec-refining",
		initialHandoffStep: "review",
		kickoffText: "Review the spec at docs/spec.md.",
		sender: "claude",
		target: "codex",
		maxRounds: 5,
		now: "2026-04-21T00:01:00Z",
	});
	return { broker, handoffId };
}

function requestText(broker: ReturnType<typeof setup>["broker"], id: string): string {
	return (
		broker.db.prepare("SELECT request_text FROM relay_handoff WHERE handoff_id = ?").get(id) as {
			request_text: string;
		}
	).request_text;
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("withHandbackFragment", () => {
	it("appends the fragment naming the handoff id", () => {
		const out = withHandbackFragment("BODY", "ho_abc");
		expect(out.startsWith("BODY\n\n--- ai-whisper handback ---\n")).toBe(true);
		expect(out).toContain("whisper handoff reply ho_abc --file <path>");
		expect(out).toContain("run: whisper turn done");
		expect(out.endsWith("--- end handback ---")).toBe(true);
	});

	it("is idempotent", () => {
		const once = withHandbackFragment("BODY", "ho_abc");
		expect(withHandbackFragment(once, "ho_abc")).toBe(once);
	});
});

describe("stored workflow requests carry the handback fragment", () => {
	it("kickoff request ends with the fragment naming its own id once", () => {
		const { broker, handoffId } = setup();
		const text = requestText(broker, handoffId);
		expect(text.startsWith("Review the spec at docs/spec.md.\n\n")).toBe(true);
		expect(text.endsWith(withHandbackFragment("", handoffId).trimStart())).toBe(true);
		expect(count(text, `whisper handoff reply ${handoffId} `)).toBe(1);
	});

	it("fix-round request ends with the fragment naming the fix handoff id once", () => {
		const { broker, handoffId } = setup();
		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "findings",
			confidence: 0.8,
			reason: "typos",
			followUpMessage: "Remove the stray TODO on line 12.",
			now: "2026-04-21T00:10:00Z",
		});
		const fixId = result.nextHandoffId!;
		const text = requestText(broker, fixId);
		expect(text).toContain("Remove the stray TODO on line 12.");
		expect(text.endsWith(withHandbackFragment("", fixId).trimStart())).toBe(true);
		expect(count(text, `whisper handoff reply ${fixId} `)).toBe(1);
		expect(text).not.toContain(handoffId);
	});

	it("phase-advance kickoff carries the fragment with its own id", () => {
		const { broker, handoffId } = setup();
		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "approve",
			confidence: 0.9,
			reason: "ok",
			now: "2026-04-21T00:10:00Z",
		});
		const nextId = result.nextHandoffId!;
		const text = requestText(broker, nextId);
		expect(count(text, `whisper handoff reply ${nextId} `)).toBe(1);
	});
});
