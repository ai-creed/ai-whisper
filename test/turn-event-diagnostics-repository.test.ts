// test/turn-event-diagnostics-repository.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@ai-whisper/broker";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import {
  insertTurnEventDiagnostic,
  listTurnEventDiagnosticsByCollab,
  deleteTurnEventDiagnosticsOlderThan,
} from "../packages/broker/src/storage/repositories/relay-turn-event-diagnostics-repository.ts";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "aiw-te-repo-"));
  const db = openDatabase(join(dir, "state.db"));
  applyMigrations(db);
  return db;
}

const base = {
  receivedAt: "2026-06-11T00:00:00.000Z",
  provider: "claude" as const,
  workspaceId: "ws1",
  cwd: "/repo",
  sessionOrThreadId: "sess1",
  turnId: null,
  workflowActive: true,
  collabId: "collab1",
  workflowId: "wf1",
  chainId: "chain1",
  handoffId: "handoff1",
  inputCorrelated: true,
  containmentScore: 0.95,
  fidelityVerdict: "clean" as const,
  deferCount: 0,
  action: "delivered" as const,
  messageLen: 42,
  messageSample: "the answer",
};

describe("relay-turn-event-diagnostics-repository", () => {
  it("inserts a row and lists it back by collab", () => {
    const db = freshDb();
    const { eventId } = insertTurnEventDiagnostic(db, base);
    expect(eventId).toMatch(/^tevt_/);
    const rows = listTurnEventDiagnosticsByCollab(db, "collab1", null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("delivered");
    expect(rows[0]?.fidelityVerdict).toBe("clean");
    expect(rows[0]?.inputCorrelated).toBe(true);
    db.close();
  });

  it("deletes rows older than a cutoff", () => {
    const db = freshDb();
    insertTurnEventDiagnostic(db, { ...base, receivedAt: "2026-06-01T00:00:00.000Z" });
    insertTurnEventDiagnostic(db, { ...base, receivedAt: "2026-06-11T00:00:00.000Z" });
    const deleted = deleteTurnEventDiagnosticsOlderThan(db, "2026-06-05T00:00:00.000Z");
    expect(deleted).toBe(1);
    expect(listTurnEventDiagnosticsByCollab(db, "collab1", null)).toHaveLength(1);
    db.close();
  });
});
