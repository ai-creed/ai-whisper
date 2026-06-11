import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTurnEvents } from "../packages/cli/src/runtime/turn-events-config.ts";

describe("resolveTurnEvents (flag > env > default)", () => {
  let prev: string | undefined;
  beforeEach(() => (prev = process.env.AI_WHISPER_TURN_EVENTS));
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_WHISPER_TURN_EVENTS;
    else process.env.AI_WHISPER_TURN_EVENTS = prev;
  });

  it("defaults to empty (off) when neither flag nor env set", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(resolveTurnEvents(undefined)).toEqual({ claude: false, codex: false });
  });
  it("env enables providers", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "claude";
    expect(resolveTurnEvents(undefined)).toEqual({ claude: true, codex: false });
  });
  it("flag overrides env", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "claude,codex";
    expect(resolveTurnEvents("codex")).toEqual({ claude: false, codex: true });
  });
});
