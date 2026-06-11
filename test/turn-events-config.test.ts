import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeClaudeSettingsFile,
  codexNotifyArgs,
} from "../packages/cli/src/runtime/turn-events-config.ts";

describe("turn-events config injection", () => {
  it("writes a claude --settings file containing only our Stop hook", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aiw-cfg-"));
    const file = writeClaudeSettingsFile({
      stateRoot, workspaceId: "ws1", shimPath: "/bin/shim", socketsDir: "/s", logsDir: "/l",
    });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = parsed.hooks.Stop[0]!.hooks[0]!.command;
    expect(cmd).toContain("/bin/shim");
    expect(cmd).toContain("--provider claude");
    expect(cmd).toContain("--socket-dir /s");
  });

  it("builds codex -c notify args pointing at the shim", () => {
    const args = codexNotifyArgs({ shimPath: "/bin/shim", socketsDir: "/s", logsDir: "/l" });
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("notify=");
    expect(args[1]).toContain("/bin/shim");
    expect(args[1]).toContain("codex");
  });
});
