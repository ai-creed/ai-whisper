# Evaluator Providers: OpenAI + Agent-CLI — Design

**Date:** 2026-06-30
**Status:** Proposed — design approved in brainstorming; awaiting spec review before implementation plan.
**Context:** ai-whisper — the LLM evaluator that gates every autonomous workflow currently supports exactly two providers: `anthropic` (default model `claude-haiku-4-5-20251001`) and `ollama` (local). This spec adds two more, shipped together in one change: `openai` (an OpenAI-compatible SDK provider) and `agent-cli` (a subprocess provider that drives an already-mounted agent CLI — `claude`/`codex`/`agy` — in non-interactive mode and reuses that CLI's own auth).

## 1. Problem

The evaluator provider set is closed at `anthropic | ollama`. Two real needs are unmet:

1. **OpenAI / OpenAI-compatible backends.** No way to point the evaluator at OpenAI, and by extension no way to reach the large ecosystem that speaks the OpenAI wire format (Azure OpenAI, OpenRouter, vLLM, LM Studio, etc.). Adding one OpenAI-compatible provider with a `baseURL` knob covers all of them.

2. **Reuse an already-authenticated agent CLI as the evaluator.** Operators already mount `claude`/`codex`/`agy` and are logged into those CLIs. Running one of them in non-interactive mode as the evaluator backend means **no separate API key** in ai-whisper config and whatever model that CLI is configured to use — a low-friction path for people who do not want to provision a dedicated evaluator key.

## 2. Goals / Non-goals

**Goals**
- Add `openai` and `agent-cli` as first-class evaluator providers, selectable as primary or fallback.
- Keep the change surgical: extend the existing provider seam; do **not** refactor it into a generic registry (YAGNI — the union is small and clean).
- Preserve every provider-agnostic behavior already in place (branch selection, system prompts, zod schemas, JSON extraction, fallback orchestration, diagnostics telemetry).
- TDD throughout, with injectable seams so no test depends on a live network, SDK hoisting, or a real subprocess.

**Non-goals**
- No provider registry / plugin abstraction.
- No streaming, no multi-turn evaluator conversations.
- No change to the evaluator prompts, branches, verdict schemas, or the workflow gate contract.
- No change to how the *worker* agents are mounted (the CompanionProvider path is reused as prior art only).

## 3. Background — the current seam

`packages/cli/src/runtime/relay-orchestrator-evaluator.ts` is provider-agnostic past the caller:

- `EvaluatorProviderConfig` is a discriminated union `AnthropicProviderConfig | OllamaProviderConfig`, each carrying an injectable `client?` plus model.
- `buildSingleProviderCaller(config)` switches on `config.provider` and returns a closure that produces a raw string; the shared `branch.parse()` (regex `/\{[\s\S]*\}/` extraction + zod) turns it into a verdict.
- `createRelayOrchestratorEvaluator({ primary, fallback?, onCall? })` runs primary, and on a `provider_unavailable` outcome falls back to the configured fallback. It emits an `EvaluatorCallEvent` per attempt for diagnostics.

`packages/cli/src/runtime/evaluator-config.ts` resolves a `ResolvedEvaluatorConfig` from env / `auth.json` / `config.json` / `.env`, computes an `EvaluatorStatus`, and gates workflow start (`isEvaluatorPreflightBlocked`).

`packages/cli/src/bin/broker-daemon.ts` `providerConfigFrom(kind)` maps a resolved provider kind to an `EvaluatorProviderConfig` for primary and fallback.

The literal type `"anthropic" | "ollama"` is echoed in three more places that must widen in lockstep: the diagnostics repository (`packages/broker/src/storage/repositories/relay-evaluator-diagnostics-repository.ts`), `packages/broker/src/control/create-control-service.ts`, and `packages/cli/src/runtime/record-evaluator-status.ts`.

**Prior art for the subprocess path:** `packages/adapter-claude/src/create-claude-provider.ts` already spawns the claude CLI non-interactively as a `CompanionProvider` — `spawn(executable, [...execArgs, prompt])`, collect stdout, map exit code to a reply. `ClaudeCommandConfig`/`CodexCommandConfig` are both literally `{ executable: string; execArgs: string[] }`. The agent-CLI evaluator caller reuses this shape and spawn pattern; it does **not** reuse the CompanionProvider interface (different concern — it returns a raw evaluator string, not a `ProviderReply`).

## 4. Design overview

One new caller per provider, registered in `buildSingleProviderCaller`'s switch. Everything downstream is untouched. The provider union grows to four:

```
EvaluatorProviderConfig =
  | AnthropicProviderConfig
  | OllamaProviderConfig
  | OpenAIProviderConfig    // new
  | AgentCliProviderConfig  // new
```

`provider` discriminant values: `"anthropic" | "ollama" | "openai" | "agent-cli"`. The diagnostics `provider` column is plain `TEXT NOT NULL` (no CHECK constraint at `apply-migrations.ts:569` and `:608`), so the new values need **no database migration** — only the TypeScript literal types widen.

## 5. OpenAI provider (SDK)

### 5.1 Config

```ts
export type OpenAIProviderConfig = {
  provider: "openai";
  apiKey: string;
  model: string;            // REQUIRED — no baked default (see 5.4)
  baseURL?: string;         // unset → api.openai.com; set → Azure / OpenRouter / vLLM / LM Studio / ...
  createClient?: OpenAIClientFactory;  // injectable client FACTORY (see 5.1.1); default wraps `new OpenAI(...)`
};
```

A minimal structural `OpenAIClientLike` is defined locally (mirroring `AnthropicClientLike`/`OllamaClientLike`) so tests can pass a plain mock without the `openai` SDK being hoisted to root `node_modules`:

```ts
export type OpenAIClientLike = {
  chat: {
    completions: {
      create(request: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: Record<string, unknown>;
        temperature?: number;
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
};
```

#### 5.1.1 Client factory seam (so `baseURL` construction is testable)

OpenAI is the only provider whose construction arguments (`baseURL`) carry behavior worth asserting, so — unlike anthropic/ollama which expose a pre-built `client?` — it injects a **factory** rather than a ready client. A pre-built `client?` would bypass `new OpenAI({ apiKey, baseURL })` entirely, so a test using it could never prove `baseURL` was passed to the SDK (AC-1) and would still pass if `baseURL` were silently dropped. The factory closes that gap:

```ts
export type OpenAIClientFactory =
  (opts: { apiKey: string; baseURL?: string }) => OpenAIClientLike;
```

- **Production default** (when `createClient` is unset): `(opts) => new OpenAI(opts)` — the only place the concrete `openai` SDK is constructed.
- **Tests** inject a factory that (a) records the `opts` it receives so the test can assert `apiKey`/`baseURL` were threaded through, and (b) returns a structural `OpenAIClientLike` mock to drive request/response/token-mapping behavior. One seam covers both the "assert construction" and "drive the call" needs; the redundant `client?` field is removed.
- `providerConfigFrom("openai")` never sets `createClient` (production uses the default factory); it only flows `apiKey`/`model`/`baseURL` from the resolved config.

### 5.2 Caller

`buildOpenAICaller(config)`:
- Client: `const client = (config.createClient ?? defaultOpenAIFactory)({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })`, where `defaultOpenAIFactory = (opts) => new OpenAI(opts)` (the sole concrete-SDK construction site). Because `baseURL` flows through the factory argument, a test injecting `createClient` can assert it was passed through (AC-1) and the production path still reaches the real endpoint.
- Call `chat.completions.create` with `messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(payload) }]`, `temperature: 0.3` (parity with ollama), and **schema-guided (non-strict) structured output** `response_format: { type: "json_schema", json_schema: { name: "verdict", schema: branch.jsonSchema } }`. `strict` is intentionally **omitted** (defaults to `false`) — see 5.2.1.
- `raw` = `choices[0].message.content ?? ""`.
- Tokens: map `usage.prompt_tokens` → `inputTokens`, `usage.completion_tokens` → `outputTokens` when present.
- The raw string still flows through `branch.parse()` — the regex (`/\{[\s\S]*\}/`) extraction + zod validation is the **authoritative** verdict validator. `response_format` is best-effort guidance only, so a backend that ignores it (some OpenAI-compatible servers do) degrades gracefully to the same extraction path the other providers use.

#### 5.2.1 Why non-strict (not `strict: true`)

OpenAI's `strict: true` structured-output mode imposes a schema subset the existing branch schemas do **not** satisfy, and cannot be made to satisfy without violating a §2 non-goal:

- Strict mode requires `additionalProperties: false` on every object and **every** property listed in `required`. The shared verdict schemas break both rules: `LEGACY_JSON_SCHEMA` (`relay-orchestrator-evaluator.ts:143-152`) declares `followUpMessage` as a property but omits it from `required` (it is meaningful only when `verdict=loop`), and neither it nor `REVIEW_JSON_SCHEMA` (`:185-193`) sets `additionalProperties: false`. Passing such a schema with `strict: true` is rejected by the OpenAI API **before any verdict is produced**, so AC-1 could never pass.
- Normalizing the schema to strict-compatible at call time (force-add `additionalProperties: false`, promote every property to `required` and make optionals `["<type>", "null"]`) would in turn require the verdict **zod** validators to accept an explicit `null` for `followUpMessage` (today they are `.optional()`, which rejects `null`). That mutates the shared verdict schemas/validators — forbidden by §2 ("No change to the evaluator prompts, branches, verdict schemas").

Non-strict `json_schema` still gives the model schema-shaped guidance (property names, enums) — better output quality than plain `json_object` mode — while leaving `branch.parse()` as the real enforcement boundary. Do **not** flip `strict` to `true` without first making the branch schemas strict-compatible and the zod validators null-tolerant; that is out of scope here.

### 5.3 Token + branch wiring

`buildSingleProviderCaller` gains an `openai` arm structurally identical to the anthropic arm (timer around the provider call only; parse after the timer stops; ok/parse-error/provider-unavailable result shape). Tokens populate `inputTokens`/`outputTokens` on the `CallResult`.

### 5.4 Required model — decision

`model` is **required with no baked default**. Rationale: with `baseURL` in play the correct model id depends entirely on the backend (`gpt-4o-mini` on OpenAI is meaningless on OpenRouter/vLLM), so a hardcoded default would be wrong as often as right and would silently rot. Anthropic keeps its existing `claude-haiku-4-5-20251001` default (single known backend); OpenAI forces an explicit choice. A `provider=openai` config with no `model` is an invalid config → surfaced as `invalid_config` at preflight (see §8).

## 6. Agent-CLI provider (subprocess)

### 6.1 Config — hybrid presets + overrides

```ts
export type AgentCliProviderConfig = {
  provider: "agent-cli";
  agent: "claude" | "codex" | "agy";  // seeds preset defaults
  executable?: string;                 // override preset
  execArgs?: string[];                 // override preset
  promptVia?: "arg" | "stdin";         // override preset
  model?: string;                      // appended per preset when the CLI supports a model flag; else ignored
  spawnImpl?: SpawnLike;               // injectable for tests
};
```

The resolved invocation is `preset(agent)` merged with any provided overrides (override wins field-by-field). `spawnImpl` defaults to `node:child_process` `spawn`; tests inject a fake.

**`agent` is required — there is no agent-less mode.** It is non-nullable on `AgentCliProviderConfig` and seeds the preset baseline even when `executable`/`execArgs`/`promptVia` are all overridden (it also labels diagnostics). The resolved `ResolvedEvaluatorConfig.agentCli.agent` is `null` **only** when `provider=agent-cli` is selected without supplying `AI_WHISPER_EVALUATOR_AGENT_CLI_AGENT` (or its config equivalent); that case is rejected deterministically at preflight as `invalid_config` (§8) — it never reaches caller construction. Accordingly, `providerConfigFrom("agent-cli")` returns `null` when `agentCli.agent === null` (matching the existing "omit the provider whose required inputs are absent" pattern), and the `invalid_config` preflight block — not a silent `ready` — is what stops the workflow. There is intentionally no default agent and no "executable-only, agent-less" config.

### 6.2 Preset defaults

Presets seed `{ executable, execArgs, promptVia }`. All values are overridable — that is the entire point of the hybrid choice. The presets are best-effort defaults that **must be validated at implementation time against the installed CLI** (acceptance criterion AC-7), exactly as the antigravity turn-events spec empirically probed `agy` v1.0.13 rather than trusting `--help` text:

| agent | executable | execArgs (default) | promptVia |
|-------|-----------|--------------------|-----------|
| claude | `claude` | `["-p"]` (print / non-interactive mode) | `arg` |
| codex  | `codex`  | `["exec"]` | `arg` |
| agy    | `agy`    | `["-p"]` (confirmed by AC-7 probe — see §6.2.1) | `arg` |

The agy probe (§6.2.1) confirmed a `-p` non-interactive mode (agy v1.0.13), so the preset is seeded concretely — matching claude. Had the probe found no non-interactive flag, the agy preset would have been documented as "bring your own `execArgs`"; the hybrid override still lets an operator drive it regardless. claude and codex presets are concrete and not conditional.

#### 6.2.1 Manual smoke results (AC-3, AC-7 — run 2026-06-30)

Probes run on the machine at commit time. Commands used `<cli> <args> 'Reply with ONLY {"verdict":"done","confidence":1,"reason":"smoke"}'` with a 30-second watchdog.

**claude `-p` (AC-3)**
```
$ claude -p 'Reply with ONLY {"verdict":"done","confidence":1,"reason":"smoke"}'
{"verdict":"done","confidence":1,"reason":"smoke"}
```
Exit 0. Preset `{ execArgs: ["-p"], promptVia: "arg" }` confirmed.

**codex `exec`**
```
$ codex exec 'Reply with ONLY {"verdict":"done","confidence":1,"reason":"smoke"}'
...
{"verdict":"done","confidence":1,"reason":"smoke"}
```
Exit 0 (OpenAI Codex v0.142.3, model gpt-5.5). Preset `{ execArgs: ["exec"], promptVia: "arg" }` confirmed.

**agy `--help` probe (AC-7) — agy v1.0.13**

`agy --help` (exit 0) revealed:
```
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
```

The conservative seed `{ execArgs: [], promptVia: "stdin" }` was updated to `{ execArgs: ["-p"], promptVia: "arg" }` to match the confirmed non-interactive mode. `pnpm vitest run test/agent-cli-presets.test.ts` passes (4/4 green) with the updated preset.

**End-to-end evaluator-pipeline smoke (AC-3) — agent-cli/claude through the real subprocess.** Beyond the raw `claude -p` invocation above, the full evaluator pipeline was run with no fakes: `createRelayOrchestratorEvaluator({ provider: "agent-cli", agent: "claude" })` with the real `defaultSpawn`, evaluating a sample legacy handoff. `buildAgentCliCaller` assembled the prompt (legacy system prompt + `JSON.stringify(payload)` + the "reply with ONLY the JSON object" instruction), spawned `claude -p <prompt>`, and `branch.parse()` extracted the verdict:

```
provider=agent-cli  branch=legacy  outcome=ok  latencyMs≈4900  tokens=null
claude returned: {"verdict":"done","confidence":0.95,"reason":"…","followUpMessage":""}
parsed verdict:   { verdict: "done", confidence: 0.95, reason: "…" }
```

The extra `followUpMessage: ""` (not a valid field on the `done` variant) was stripped by the non-strict zod parse — confirming the `/\{[\s\S]*\}/` extraction + zod validation is the authoritative validator against live, slightly-noisy CLI output. `tokens=null` as designed (CLIs do not report usage). This validates AC-3 at the evaluator-pipeline level, not just the CLI-invocation level. (Run via a throwaway `tsx` script driving the real source; not committed.)

### 6.3 Caller

`buildAgentCliCaller(config)` resolves `{ executable, execArgs, promptVia }`, then per call:
- Assemble a single prompt string (CLIs have no system role): the branch system prompt, a clear delimiter, `JSON.stringify(payload)`, and a trailing instruction "Reply with ONLY the JSON object described above — no prose, no code fence."
- `promptVia: "arg"` → `spawn(executable, [...execArgs, prompt], { stdio: ["ignore","pipe","pipe"] })`.
- `promptVia: "stdin"` → `spawn(executable, execArgs, { stdio: ["pipe","pipe","pipe"] })`, write the prompt to stdin, end it.
- Collect stdout; on `error` (e.g. `ENOENT`) or non-zero exit, throw an `Error` (carrying stderr) classified as `provider_unavailable` so a configured fallback engages.
- `raw` = stdout; flows through `branch.parse()`, whose regex extraction tolerates surrounding agent chatter / markdown fences.
- Tokens: `null` (CLIs do not report usage; telemetry already handles null).

### 6.4 No schema enforcement

Agent CLIs cannot guarantee a JSON shape the way OpenAI/Ollama structured-output can. Agent-CLI mode therefore relies on the assembled prompt + the existing regex extraction + zod validation (with the existing one-shot parse-error path). This is a documented tradeoff: slightly higher parse-retry risk than the SDK providers, accepted for a reuse-my-existing-auth convenience path. A preset whose CLI offers a JSON-output flag may include it in `execArgs`; any envelope is unwrapped generically by the `/\{[\s\S]*\}/` extraction (it finds the inner verdict object regardless of wrapper).

## 7. Config resolution, env, precedence

`ResolvedEvaluatorConfig` (in `evaluator-config.ts`) widens:

```ts
provider: "anthropic" | "ollama" | "openai" | "agent-cli";
fallback: "anthropic" | "ollama" | "openai" | "agent-cli" | null;
openai:   { apiKey: string | null; model: string | null; baseURL: string | null };
agentCli: { agent: "claude" | "codex" | "agy" | null; executable: string | null; execArgs: string[] | null; promptVia: "arg" | "stdin" | null; model: string | null };
```

New env knobs follow the existing env-over-auth-over-config precedence and naming:
- `OPENAI_API_KEY` (also read from `auth.json` `OPENAI_API_KEY`), `AI_WHISPER_EVALUATOR_OPENAI_MODEL`, `AI_WHISPER_EVALUATOR_OPENAI_BASE_URL`.
- `AI_WHISPER_EVALUATOR_AGENT_CLI_AGENT` (+ `config.json` `evaluator.agentCli.{executable,execArgs,promptVia,model}` for overrides).
- `AI_WHISPER_EVALUATOR_PROVIDER` / `_FALLBACK` already exist; they now accept the two new values.

`broker-daemon.ts` `providerConfigFrom(kind)` gains `openai` and `agent-cli` arms that build the respective `EvaluatorProviderConfig` from the resolved config (returning `null` when the provider's required inputs are absent, matching the existing pattern that lets `provider=X + fallback=Y + missing X inputs` omit the broken side).

## 8. Readiness / preflight & status

`EvaluatorStatus` gains two values: `missing_openai_key` and `agent_cli_unavailable`. `computeEvaluatorStatus` extends:

- `provider=openai`, `apiKey === null` → `missing_openai_key` (blocking).
- `provider=openai`, `model === null` → `invalid_config` (blocking; reuses existing status — required-model violation).
- `provider=agent-cli`, `agentCli.agent === null` → `invalid_config` (blocking; reuses existing status — required-input violation, mirrors the OpenAI missing-`model` rule). `agent` is **required** even when every other field is overridden: it selects the preset baseline and labels telemetry, and there is **no** default agent (the three CLIs differ too much to guess). See §6.1.
- `provider=agent-cli`, `agent` set → resolve `{ executable }` (preset+override) and check it resolves on `PATH`; if not found → `agent_cli_unavailable` (blocking). Auth/runtime failures are **not** preflighted (no probe call — too slow/costly at start); they surface at first call as `provider_unavailable` and engage fallback if configured.
- Otherwise → `ready`.

`isEvaluatorPreflightBlocked` adds `missing_openai_key` and `agent_cli_unavailable` to the blocking set. `whisper env --json`'s `evaluator: { status, ready }` block reports the new statuses with actionable remediation text. The PATH check is a pure-filesystem lookup (no spawn), consistent with the spec's "resolved from config alone, without a running daemon" property of the env report.

## 9. Error handling & telemetry

- `isProviderUnavailableError` already matches `ECONNREFUSED/ENOTFOUND/ETIMEDOUT/ECONNRESET` and HTTP `429`/`>=500`. The OpenAI SDK throws status-bearing errors (covered) and the subprocess path throws `ENOENT`/non-zero-exit errors — the agent-CLI caller maps spawn failure and non-zero exit to an error that classifies as `provider_unavailable`.
- `EvaluatorCallEvent.provider`, the `runOne` provider param, and `createRelayOrchestratorEvaluator`'s provider locals widen to the four-value union.
- Diagnostics storage: `relay-evaluator-diagnostics-repository.ts` row type and cast widen to the four-value union. Column stays `TEXT` — no migration.

## 10. Files touched

Grouped for the implementation plan to chunk (the change spans >3 files, so it decomposes into three reviewable chunks):

**Chunk A — shared type widening (small, mechanical):**
- `packages/cli/src/runtime/relay-orchestrator-evaluator.ts` — `EvaluatorCallEvent.provider`, `runOne` param, evaluator provider locals.
- `packages/broker/src/storage/repositories/relay-evaluator-diagnostics-repository.ts`, `packages/broker/src/control/create-control-service.ts`, `packages/cli/src/runtime/record-evaluator-status.ts` — echo the union.

**Chunk B — OpenAI provider:**
- `relay-orchestrator-evaluator.ts` — `OpenAIClientLike`, `OpenAIClientFactory`, `defaultOpenAIFactory`, `OpenAIProviderConfig`, `buildOpenAICaller`, switch arm.
- `evaluator-config.ts` — resolve `openai.*`, statuses, required-model check.
- `broker-daemon.ts` — `providerConfigFrom` openai arm.
- `package.json` — add `openai` dependency.

**Chunk C — Agent-CLI provider:**
- `relay-orchestrator-evaluator.ts` — `AgentCliProviderConfig`, presets, `buildAgentCliCaller`, switch arm.
- `evaluator-config.ts` — resolve `agentCli.*`, PATH preflight, `agent_cli_unavailable`.
- `broker-daemon.ts` — `providerConfigFrom` agent-cli arm.

## 11. Testing (TDD)

Per provider, write the failing test first:
- **OpenAI caller:** injected `OpenAIClientFactory` returns a mock whose `create` yields ok JSON → verdict; returns malformed → `parse_error`; throws status-500 → `provider_unavailable`; token mapping `prompt_tokens`/`completion_tokens` → telemetry; **factory receives `baseURL`** — the injected factory records its `opts` and the test asserts `opts.baseURL === <configured baseURL>` (and `opts.apiKey`), so the test fails if `baseURL` is dropped; `response_format` carries `branch.jsonSchema` unchanged with **no** `strict` flag (assert `strict` is absent / not `true`).
- **Agent-CLI caller:** injected fake spawn → `arg` delivery appends prompt as last arg; `stdin` delivery writes+ends stdin; non-zero exit → `provider_unavailable` carrying stderr; `ENOENT` → `provider_unavailable`; stdout with surrounding chatter / markdown fence → extracted verdict; preset+override merge precedence (override wins field-by-field).
- **Resolver:** new env/auth/config precedence for openai + agent-cli; required-model → `invalid_config`; missing openai key → `missing_openai_key`; `provider=agent-cli` with `agent === null` → `invalid_config` (and `providerConfigFrom` returns `null`); missing executable on PATH → `agent_cli_unavailable`; `ready` happy paths.
- **Fallback:** primary `agent-cli` unavailable → fallback `anthropic` returns verdict; primary `openai` unavailable → fallback `ollama`. Confirms the four-value union round-trips through fallback orchestration and the diagnostics `provider` column.

Reuse existing evaluator test helpers; prefer them over bespoke setup where they make the tests cleaner.

## 12. Edge cases

- OpenAI-compatible backend that ignores `response_format` → graceful regex parse.
- `provider=openai` with no `model` → `invalid_config` (not a silent default).
- `provider=agent-cli` with no `agent` resolved (env/config unset) → `invalid_config` at preflight (no default agent; not a silent `ready`).
- Agent-CLI binary missing / not on `PATH` → `agent_cli_unavailable` at preflight.
- CLI writes only to stderr, or exits 0 with empty stdout → `parse_error` (no extractable JSON). This is **not** `provider_unavailable`, so it does **not** engage fallback — it follows the existing one-shot parse-error retry against the **same** provider (`relay-orchestrator-evaluator.ts:710-719` only falls back on `provider_unavailable`). Only a spawn `error` (e.g. `ENOENT`) or a **non-zero** exit is classified `provider_unavailable` (§6.3) and can engage fallback.
- Prompt exceeding OS arg-length limits → favor `promptVia: "stdin"` (documented in the preset guidance).
- CLI emitting markdown-fenced or chatter-wrapped JSON → regex extraction handles it.
- Fallback engaged (primary was `provider_unavailable`) and the fallback provider also fails → the **fallback** provider's error is thrown (existing behavior — `relay-orchestrator-evaluator.ts:715-717` throws `fallbackResult.error`). When fallback is **not** engaged (primary outcome is anything other than `provider_unavailable`, or no fallback is configured), the **primary** error is thrown (`:719`).
- New provider value persisted to and read back from the `TEXT` diagnostics column.

## 13. Acceptance criteria

- **AC-1** `provider=openai` (+ key + model) gates a workflow successfully end to end; `provider=openai` + `baseURL` is proven to reach a non-OpenAI endpoint via an injected `OpenAIClientFactory` that asserts it received `opts.baseURL` (the construction seam — a pre-built client could not prove this).
- **AC-2** `provider=openai` with no `model` → workflow start blocked with `invalid_config` remediation; with no key → `missing_openai_key`.
- **AC-3** `provider=agent-cli, agent=claude` evaluates a real handoff via a non-interactive `claude` spawn (injected-spawn unit test + one manual smoke against the installed CLI).
- **AC-4** Agent-CLI override path: custom `executable`/`execArgs`/`promptVia` fully replaces the preset.
- **AC-5** `provider=agent-cli` with the executable absent from `PATH` → workflow start blocked with `agent_cli_unavailable`; `provider=agent-cli` with no `agent` resolved → workflow start blocked with `invalid_config` (no default agent).
- **AC-6** Fallback works across new pairings (agent-cli→anthropic, openai→ollama).
- **AC-7** claude and codex preset invocations are validated against the installed CLIs; the agy preset's non-interactive invocation is probed and either seeded concretely or documented as override-only.
- **AC-8** `whisper env --json` reports the new statuses; all existing gates stay green (lint, types, bundle self-containment smoke).

## 14. Open questions

None outstanding — the two design decisions (OpenAI required-model, agent-CLI PATH preflight) were resolved during brainstorming. AC-7 is a verification task, not an open design question.
