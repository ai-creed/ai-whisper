// test/control-turn-event-diagnostics.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function service() {
  const dir = mkdtempSync(join(tmpdir(), "aiw-te-ctrl-"));
  return createBrokerRuntime({ sqlitePath: join(dir, "state.db"), host: "127.0.0.1", port: 4704 });
}

describe("control turn-event diagnostics", () => {
  it("records a row and sweeps by cutoff", () => {
    const broker = service();
    try {
      const { eventId } = broker.control.recordTurnEventDiagnostic({
        receivedAt: "2026-06-01T00:00:00.000Z",
        provider: "codex",
        workspaceId: "ws",
        cwd: "/r",
        sessionOrThreadId: "t",
        turnId: "turn1",
        workflowActive: true,
        collabId: "c1",
        workflowId: "wf",
        chainId: "ch",
        handoffId: "h",
        inputCorrelated: false,
        containmentScore: null,
        fidelityVerdict: "n/a",
        deferCount: 0,
        action: "ignored_unrelated_turn",
        messageLen: 5,
        messageSample: "hello",
      });
      expect(eventId).toMatch(/^tevt_/);
      expect(broker.control.listTurnEventDiagnosticsByCollab("c1", null)).toHaveLength(1);
      const removed = broker.control.sweepTurnEventDiagnostics({
        cutoffIso: "2026-06-05T00:00:00.000Z",
      });
      expect(removed).toBe(1);
      expect(broker.control.listTurnEventDiagnosticsByCollab("c1", null)).toHaveLength(0);
    } finally {
      broker.db.close();
    }
  });
});
