# codex-plugin-cc comparison and parked improvement ideas

- **Date:** 2026-07-08
- **Status:** Parked — no active work planned. Revisit if adapter reliability, review-output parsing, or distribution friction becomes a priority.
- **Source:** Exploration of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (official OpenAI plugin, commit `db52e28`, v1.0.6) compared against ai-whisper.

## What codex-plugin-cc is

A small (~2k LOC) official Claude Code plugin that lets Claude Code delegate work one-way to Codex. It is not an orchestration system: no pairing, no workflow engine, no evaluator. The human stays the orchestrator, and the plugin explicitly forbids auto-applying review fixes.

Components:

- **Commands:** `/codex:review` (maps to Codex's native built-in reviewer), `/codex:adversarial-review` (steerable skeptic review with JSON-schema output), `/codex:rescue` (delegate a task), `/codex:transfer` (import a Claude transcript into a resumable Codex thread), `/codex:status|result|cancel` (background job control), `/codex:setup` (doctor command).
- **Runtime:** talks to the Codex app-server over JSON-RPC (stdio) — no PTY or TUI scraping. A small per-workspace broker daemon on a unix socket keeps the app-server warm. Structured output via per-turn `outputSchema`, cancellation via protocol interrupt, thread persistence with `--resume-last`.
- **Jobs:** detached node worker, JSON job files per workspace, per-job log files, Claude-session-id tagging, queued → running → done lifecycle.
- **Stop-hook review gate (opt-in):** on Claude's `Stop` hook, Codex reviews the last turn; the first output line must be `ALLOW: …` or `BLOCK: …`, and a block forces Claude to fix issues before stopping. Guardrails: only review turns that actually made edits, verify edits from repository state rather than trusting Claude's claim, and warn users the gate can drain usage limits.
- **Skills:** `gpt-5-4-prompting` (XML block prompt contracts, recipes, antipatterns), `codex-cli-runtime` and `codex-result-handling` (internal contracts for the forwarding subagent).
- **Subagent:** `codex-rescue` — a strict thin forwarder: exactly one Bash call, no repository inspection, return stdout verbatim, return nothing on failure.

## Key differences vs ai-whisper

| Axis | codex-plugin-cc | ai-whisper |
|---|---|---|
| Relationship | Master/worker: Claude host, Codex tool | Symmetric peers, baton handoff |
| Integration | Codex app-server JSON-RPC (headless, structured) | PTY-driving real interactive CLIs |
| Providers | Codex only | Five providers behind adapters |
| Orchestration | Single commands + background jobs | Durable multi-phase workflows, evaluator, rounds, escalation, resume |
| Review | One-shot, stateless, schema-validated JSON | Iterative loop with verdicts, re-handoffs, round budget |
| Distribution | Claude Code plugin marketplace | Standalone npm CLI + daemon + terminals |
| State | JSON files per workspace | SQLite broker |

## Parked improvement ideas (ranked)

1. **Headless protocol adapters where the vendor exposes one.** Their reliability comes from app-server JSON-RPC: structured events, output schemas, clean interrupt, thread resume — zero PTY text scraping. An optional "protocol mode" per adapter (Codex app-server; Claude stream-json/Agent SDK) would make capture and verdict parsing deterministic. Mounted PTY stays the human-visible identity; protocol mode fits evaluator-side or headless reuse.
2. **Schema-enforced review output.** They pass a JSON schema (verdict enum, findings with severity/file/lines/confidence) into the turn itself, so parsing is guaranteed at generation time. Where a provider supports output schemas, enforce reviewer verdict shape at the source instead of post-parsing printed matrix text.
3. **Stop-gate pattern as a lightweight product tier.** An opt-in Stop-hook cross-model review on every turn end, with no workflow ceremony, could sit between plain mount and full workflow as a cheap adoption ramp. Their guardrails (edit-detection before reviewing, repo-state verification, single-line ALLOW/BLOCK contract) are worth copying.
4. **Thin-forwarder discipline for kickoff skills.** Hard verbatim-return contracts (one call, no repo inspection, no paraphrasing, return nothing on failure) prevent the host model from mutating handoff payloads or doing the work itself.
5. **Per-provider prompt-shaping layer.** Adapter-level prompt profiles (Codex-tuned vs Claude-tuned handoff framing, XML block contracts). Their `adversarial-review` prompt (attack-surface list, finding bar, grounding rules) is a strong artifact to mine for reviewer-role guidance.
6. **Native-first review.** When the mounted agent has a native review capability (Codex's built-in reviewer), invoke it from the review handoff rather than generic instructions.
7. **Provider-native session/thread continuity.** Persist provider session/thread ids per handoff to allow "open this exact reviewer session in Codex" auditing; their `/codex:transfer` shows vendors support external-agent session import.
8. **Marketplace distribution.** A thin Claude Code plugin wrapper (skills + hooks bundled) would cut install friction for the Claude side of every pair compared to `whisper skill install`.

## Decision

Recorded 2026-07-08: none of these add enough value to ai-whisper right now to schedule work. Kept as a reference for when the relevant pain (PTY capture flakiness, verdict parse failures, skill-install friction) actually surfaces.
