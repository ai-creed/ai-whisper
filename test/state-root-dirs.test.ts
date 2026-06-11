// test/state-root-dirs.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  getStateSocketsDir,
  getStateLogsDir,
} from "../packages/cli/src/runtime/state-root.ts";

describe("state-root sub-directories", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AI_WHISPER_STATE_ROOT;
    process.env.AI_WHISPER_STATE_ROOT = "/tmp/aiw-fake-root";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
    else process.env.AI_WHISPER_STATE_ROOT = prev;
  });

  it("derives sockets/ and logs/ under the state root", () => {
    expect(getStateSocketsDir()).toBe(join("/tmp/aiw-fake-root", "sockets"));
    expect(getStateLogsDir()).toBe(join("/tmp/aiw-fake-root", "logs"));
  });
});
