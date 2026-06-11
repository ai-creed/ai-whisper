// test/turn-event-diagnostics-migration.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@ai-whisper/broker";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";

describe("relay_turn_event_diagnostics migration", () => {
  it("creates the table with the expected columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiw-mig-"));
    const db = openDatabase(join(dir, "state.db"));
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(relay_turn_event_diagnostics)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      "event_id", "received_at", "provider", "workspace_id", "cwd",
      "session_or_thread_id", "turn_id", "workflow_active", "collab_id",
      "workflow_id", "chain_id", "handoff_id", "input_correlated",
      "containment_score", "fidelity_verdict", "defer_count", "action",
      "message_len", "message_sample",
    ]) {
      expect(names).toContain(expected);
    }
    db.close();
  });
});
