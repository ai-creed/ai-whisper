#!/usr/bin/env node
// Dependency-free turn-completion shim. Spawned by the provider CLI on each
// turn-complete. It does the MINIMUM: parse cwd (to route the socket), forward
// the RAW provider payload to the mount in a thin envelope, append an arrival
// log line, exit. It does NOT normalize or read transcripts — that happens
// mount-side in the EventReceiver (which has fs + parsing). NO heavy deps.
import { connect } from "node:net";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AgentType } from "@ai-whisper/shared";

// Type-only import (erased at build/strip time) keeps the shim dependency-free
// while using the canonical agent-type union (AgentType drift guard).
type Provider = Exclude<AgentType, "ezio">;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function workspaceId(cwd: string): string {
	return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16);
}

function readPayload(provider: Provider): string {
	if (provider === "codex") {
		// codex appends the event JSON as the FINAL argv.
		return process.argv[process.argv.length - 1] ?? "";
	}
	// claude pipes the payload on stdin.
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

// Parse ONLY cwd from the raw payload, for socket routing. Returns "" if absent.
function extractCwd(raw: string): string {
	try {
		const p = JSON.parse(raw) as Record<string, unknown>;
		return typeof p["cwd"] === "string" ? (p["cwd"]) : "";
	} catch {
		return "";
	}
}

function logArrival(
	logDir: string,
	provider: Provider,
	cwd: string,
	socketPath: string,
	connectResult: "ok" | "refused" | "error",
	bytes: number,
	receivedAt: string,
): void {
	try {
		mkdirSync(logDir, { recursive: true });
		const date = receivedAt.slice(0, 10);
		const line = JSON.stringify({
			ts: receivedAt,
			provider,
			cwd,
			socket: socketPath,
			connect: connectResult,
			bytes,
		});
		appendFileSync(join(logDir, `turn-events-${date}.jsonl`), line + "\n");
	} catch {
		// logging must never throw — silent.
	}
}

function main(): void {
	const provider = (arg("--provider") as Provider) ?? "claude";
	const socketDir = arg("--socket-dir") ?? "";
	const logDir = arg("--log-dir") ?? socketDir.replace(/sockets$/, "logs");
	const explicitWorkspaceId = arg("--workspace-id");
	const event = arg("--event"); // agy tags the lifecycle event; undefined for claude/codex
	const receivedAt = new Date().toISOString();
	const raw = readPayload(provider);
	// agy's PreToolUse is a DECISION hook: it must receive {"decision":"allow"} on
	// stdout or it blocks the tool call. Emit it now — after reading the payload,
	// before the best-effort forward — so the decision lands on EVERY exit path
	// (forwarded, refused/error, the missing-wid early exit below, and the watchdog).
	// Other agy events ignore stdout; claude/codex never read it, so emit only for agy.
	if (provider === "agy") {
		try {
			process.stdout.write('{"decision":"allow"}');
		} catch {
			/* stdout must never crash the shim */
		}
	}
	const cwd = extractCwd(raw); // "" for agy (payload has no cwd)
	// Routing source: explicit --workspace-id (agy) takes precedence; otherwise
	// derive it from the payload cwd (claude/codex). Never exit on a missing cwd
	// when an explicit id is present.
	const wid = explicitWorkspaceId ?? (cwd ? workspaceId(cwd) : "");
	if (!wid) {
		logArrival(logDir, provider, cwd, "", "error", raw.length, receivedAt);
		process.exit(0); // allow decision (for agy) already printed above
	}
	const socketPath = join(socketDir, `${wid}-${provider}.sock`);
	// Thin envelope: provider tag + raw payload + arrival timestamp (+ event for agy).
	const out = JSON.stringify({ provider, raw, receivedAt, ...(event ? { event } : {}) });
	const sock = connect(socketPath);
	let settled = false;
	const done = (result: "ok" | "refused" | "error") => {
		if (settled) return;
		settled = true;
		logArrival(logDir, provider, cwd, socketPath, result, out.length, receivedAt);
		try {
			sock.end();
		} catch {
			/* ignore */
		}
		process.exit(0);
	};
	sock.on("connect", () => {
		sock.write(out, () => done("ok"));
	});
	sock.on("error", (err: NodeJS.ErrnoException) => {
		done(
			err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "refused" : "error",
		);
	});
	// Hard timeout: never hang the provider's turn.
	setTimeout(() => done("error"), 2000).unref();
}

main();
