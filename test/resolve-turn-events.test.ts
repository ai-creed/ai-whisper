import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveTurnEvents,
  unrecognizedTurnEventsTokens,
} from "../packages/cli/src/runtime/turn-events-config.ts";

describe("resolveTurnEvents (flag > env > default ON)", () => {
  let prev: string | undefined;
  beforeEach(() => (prev = process.env.AI_WHISPER_TURN_EVENTS));
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_WHISPER_TURN_EVENTS;
    else process.env.AI_WHISPER_TURN_EVENTS = prev;
  });

  it("defaults to ON for both providers when neither flag nor env set", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(resolveTurnEvents(undefined)).toEqual({ claude: true, codex: true, agy: true });
  });

  it("treats an explicit 'off' env as the clipboard kill-switch (both off)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "off";
    expect(resolveTurnEvents(undefined)).toEqual({ claude: false, codex: false, agy: false });
  });

  it("treats an explicit 'none' env as the clipboard kill-switch (both off)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "none";
    expect(resolveTurnEvents(undefined)).toEqual({ claude: false, codex: false, agy: false });
  });

  it("treats an explicit empty env as the clipboard kill-switch (both off)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "";
    expect(resolveTurnEvents(undefined)).toEqual({ claude: false, codex: false, agy: false });
  });

  it("an explicit allow-list scopes enablement to exactly that set (per-provider kill-switch)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "claude";
    expect(resolveTurnEvents(undefined)).toEqual({ claude: true, codex: false, agy: false });
  });

  it("flag overrides env", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "claude,codex";
    expect(resolveTurnEvents("codex")).toEqual({ claude: false, codex: true, agy: false });
  });

  it("an 'off' flag overrides an enabling env", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "claude,codex";
    expect(resolveTurnEvents("off")).toEqual({ claude: false, codex: false, agy: false });
  });

  it("is case- and whitespace-insensitive for tokens", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(resolveTurnEvents("  CLAUDE , Codex ")).toEqual({ claude: true, codex: true, agy: false });
  });

  it("includes agy in the default-on set and honors an explicit agy allow-list", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(resolveTurnEvents(undefined)).toEqual({ claude: true, codex: true, agy: true });
    expect(resolveTurnEvents("agy")).toEqual({ claude: false, codex: false, agy: true });
  });
});

describe("unrecognizedTurnEventsTokens (typo guard)", () => {
  let prev: string | undefined;
  beforeEach(() => (prev = process.env.AI_WHISPER_TURN_EVENTS));
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_WHISPER_TURN_EVENTS;
    else process.env.AI_WHISPER_TURN_EVENTS = prev;
  });

  it("returns [] when neither flag nor env is set", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(unrecognizedTurnEventsTokens(undefined)).toEqual([]);
  });

  it("returns [] for an empty value (the explicit kill-switch)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "";
    expect(unrecognizedTurnEventsTokens(undefined)).toEqual([]);
  });

  it("returns [] for all recognized provider and control tokens", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(unrecognizedTurnEventsTokens("claude,codex,off,none")).toEqual([]);
  });

  it("flags an unrecognized token (the typo footgun)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "clade";
    expect(unrecognizedTurnEventsTokens(undefined)).toEqual(["clade"]);
  });

  it("flags only the unrecognized tokens in a mixed list", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(unrecognizedTurnEventsTokens("claude,clade")).toEqual(["clade"]);
  });

  it("dedupes and lowercases unrecognized tokens", () => {
    delete process.env.AI_WHISPER_TURN_EVENTS;
    expect(unrecognizedTurnEventsTokens("Clade, clade ,CLADE")).toEqual(["clade"]);
  });

  it("resolves the flag over env (flag typo is flagged even with a clean env)", () => {
    process.env.AI_WHISPER_TURN_EVENTS = "claude";
    expect(unrecognizedTurnEventsTokens("codex,bogus")).toEqual(["bogus"]);
  });
});
