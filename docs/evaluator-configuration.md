# Evaluator configuration (required for workflows)

The bundled workflows (`spec-driven-development`, `quick-task`, `ralph-loop`, `complex-bug-fixing`, `deliberation`) use an LLM **evaluator** to judge each handoff. All of them use the same evaluator credentials, configured once as described below. The default provider is **Anthropic**; **OpenAI** (and OpenAI-compatible backends), a local **Ollama** model, or an **already-mounted agent CLI** (`claude`/`codex`/`agy`) are also supported. The evaluator requires credentials. Without them, a workflow bails at kickoff with a remediation message — both the kickoff skills and `whisper workflow start` refuse to start rather than halting partway into a run. So this is required setup before running any workflow.

Configuration lives in `~/.ai-whisper/` (the same root as `state.db`), so it is set once and is independent of which shell spawned the daemon.

## Quick setup (Anthropic)

Create `~/.ai-whisper/auth.json` with your API key, then lock it down:

```bash
mkdir -p ~/.ai-whisper
cat > ~/.ai-whisper/auth.json <<'JSON'
{ "ANTHROPIC_API_KEY": "sk-ant-..." }
JSON
chmod 600 ~/.ai-whisper/auth.json
```

That is enough to run the workflows with the default Anthropic provider.

## Optional settings (`config.json`)

Non-secret evaluator settings go in `~/.ai-whisper/config.json`. All fields are optional and fall back to built-in defaults:

```json
{
  "evaluator": {
    "provider": "anthropic",
    "fallback": "ollama",
    "anthropicModel": "claude-haiku-4-5-20251001",
    "ollama": { "host": "http://localhost:11434", "model": "qwen2.5:7b-instruct" },
    "openai": { "model": "gpt-4o-mini", "baseURL": null },
    "agentCli": { "agent": "claude" }
  }
}
```

- `provider` — `"anthropic"` (default), `"ollama"`, `"openai"`, or `"agent-cli"`.
- `fallback` — provider to retry once on a provider-unavailable error (any of the four values); omit for none. Fallback engages **only** on a provider-unavailable error (connection refused, timeout, HTTP 429/5xx, or a failed agent-CLI spawn / non-zero exit) — not on a parse error.
- `anthropicModel` — overrides the evaluator's default Anthropic model, which is `claude-haiku-4-5-20251001`. Haiku is the default on purpose: the done/loop/escalate verdict is a lightweight judgment that doesn't need a larger model, and haiku keeps per-handoff cost low. Only override this if you have a specific reason to.
- `ollama.host` / `ollama.model` — used when the provider or fallback is `ollama`.
- `openai.model` (**required** when the provider or fallback is `openai`) / `openai.baseURL` (optional) — see **Using OpenAI** below.
- `agentCli.agent` (**required** when the provider or fallback is `agent-cli`) plus optional `executable` / `execArgs` / `promptVia` overrides — see **Using an already-mounted agent CLI** below.

Providers that do **not** need an Anthropic key: `ollama` (local), `openai` (uses an OpenAI key), and `agent-cli` (reuses the mounted CLI's own auth).

## Using OpenAI (or an OpenAI-compatible backend)

Set `provider` (or `fallback`) to `"openai"`. OpenAI needs a key and an **explicit model** — there is no default model, because with `baseURL` in play the right model id depends entirely on the backend.

1. Put the key in `~/.ai-whisper/auth.json` (alongside or instead of the Anthropic key):

   ```json
   { "OPENAI_API_KEY": "sk-..." }
   ```

2. Choose the provider and model in `config.json`:

   ```json
   { "evaluator": { "provider": "openai", "openai": { "model": "gpt-4o-mini" } } }
   ```

To reach an **OpenAI-compatible** backend (Azure OpenAI, OpenRouter, vLLM, LM Studio, …), set `openai.baseURL` (or `AI_WHISPER_EVALUATOR_OPENAI_BASE_URL`) to its endpoint and use that backend's model id. The evaluator asks for JSON via the model's structured-output (a non-strict `json_schema`); a backend that ignores it still works, because the verdict JSON is extracted and schema-validated on our side regardless.

If `provider=openai` has no key, kickoff is blocked with status `missing_openai_key`; if it has no model, status `invalid_config`.

## Using an already-mounted agent CLI (`claude`/`codex`/`agy`)

Set `provider` (or `fallback`) to `"agent-cli"` to run one of your mounted agent CLIs in non-interactive mode as the evaluator. **No separate API key** — it reuses whatever auth that CLI is already signed in with, and whatever model that CLI is configured to use. This is the lowest-friction path if you do not want to provision a dedicated evaluator key.

```json
{ "evaluator": { "provider": "agent-cli", "agentCli": { "agent": "claude" } } }
```

`agent` is **required** (`"claude"`, `"codex"`, or `"agy"`) — there is no default. Each agent has a validated preset for its non-interactive invocation (all three use `-p` / print mode today); the evaluator spawns e.g. `claude -p <prompt>`, reads the JSON verdict from the CLI's stdout, and validates it.

Optional overrides (under `agentCli`) replace individual preset fields:

- `executable` — an absolute path or a different binary name (e.g. `/opt/homebrew/bin/claude`).
- `execArgs` — replace the preset args.
- `promptVia` — `"arg"` (append the prompt as the last argument; the default for every preset) or `"stdin"` (write the prompt to the process's stdin).
- `model` — currently a no-op: no preset wires a model flag, so the CLI uses its own configured model. To pin a model, pass it via `execArgs` or the CLI's own config.

At kickoff the resolved executable is checked on `PATH` (a pure filesystem lookup, no spawn): if it is not found, status is `agent_cli_unavailable`. A resolved config with no `agent` is `invalid_config`. Auth/runtime failures are **not** pre-checked — they surface on the first call as a provider-unavailable error and engage the fallback if one is configured.

> Tradeoff: agent CLIs cannot guarantee JSON output the way the SDK providers' structured output can, so this path relies on the same regex-extraction + schema-validation the other providers use as a safety net. It tolerates surrounding chatter / markdown fences, at a slightly higher parse-retry risk — accepted for the reuse-my-existing-auth convenience.

## Optional env-style file (`.env`)

For users who prefer env-style config, `~/.ai-whisper/.env` accepts the same secret and `AI_WHISPER_EVALUATOR_*` variables — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_WHISPER_EVALUATOR_PROVIDER`, `AI_WHISPER_EVALUATOR_FALLBACK`, `AI_WHISPER_EVALUATOR_OPENAI_MODEL`, `AI_WHISPER_EVALUATOR_OPENAI_BASE_URL`, `AI_WHISPER_EVALUATOR_OLLAMA_HOST`, `AI_WHISPER_EVALUATOR_OLLAMA_MODEL`, and `AI_WHISPER_EVALUATOR_AGENT_CLI_AGENT`. It is loaded by the config layer, not the shell. The parser is intentionally minimal: `KEY=VALUE` lines, `#` comments, blank lines, and surrounding single/double quotes — no interpolation or escaping. For anything fancier, export a real environment variable (highest precedence).

## Precedence

Per resolved value, highest to lowest:

1. Exported process environment variable
2. `~/.ai-whisper/.env`
3. `~/.ai-whisper/auth.json` (secrets) / `~/.ai-whisper/config.json` (settings)
4. Built-in defaults

Existing env-var users are unaffected — exported env vars still win.

## Restart after changing config

The daemon reads this configuration **once at startup**. After editing any of these files, restart the daemon for the change to take effect: `whisper collab stop`, then re-mount (or otherwise restart the broker).

## Migration from a workspace `.env`

The daemon no longer reads a workspace/cwd `.env`. If you previously relied on a project `.env` to feed the daemon's `ANTHROPIC_API_KEY` / `AI_WHISPER_EVALUATOR_*`, move those values into `~/.ai-whisper/auth.json`, `config.json`, or `.env`.

## Verify

```bash
whisper collab status --json
```

Check the `evaluator` field — `evaluator.ready` should be `true` and `evaluator.status` should be `"ready"`. A `false` reading reports the reason in `status` so you know what to fix: `missing_anthropic_key`, `missing_openai_key`, `agent_cli_unavailable` (the agent-CLI executable was not found on `PATH`), or `invalid_config` (malformed JSON, or a required setting missing — e.g. `provider=openai` without a model, or `provider=agent-cli` without an agent). The same block is also reported by `whisper env --json`.
