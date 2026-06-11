// test/turn-event-retention-sweep.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTurnEventLogs } from "../packages/broker/src/runtime/diagnostics-sweep.ts";

describe("turn-event dated-file retention sweep", () => {
  it("unlinks dated JSONL files older than the cutoff, keeps newer", () => {
    const logsDir = mkdtempSync(join(tmpdir(), "aiw-te-logs-"));
    const old = join(logsDir, "turn-events-2026-06-01.jsonl");
    const fresh = join(logsDir, "turn-events-2026-06-11.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(fresh, "{}\n");
    const unlinked = sweepTurnEventLogs(logsDir, "2026-06-05");
    expect(unlinked).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
