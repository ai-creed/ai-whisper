// test/codex-turn-event-smoke.test.ts
//
// Deterministic codex turn-event smoke. Closes the "zero codex rows in
// relay_turn_event_diagnostics" gap by driving the FULL codex receive path
// end-to-end through real code:
//
//   real turn-event-shim (--provider codex, payload as FINAL argv)
//     → real Unix socket → real createTurnEventListener (CodexEventReceiver)
//       → real createMountedTurnOwnedRelay gate → delivered codex diagnostics row
//
// This is the codex twin of test/turn-event-integration.test.ts, but it ALSO
// spawns the real shim (which that test omits) — exercising the two codex-unique
// legs that no other test covers at runtime:
//   1. the shim reading the payload from the FINAL argv (not stdin) and routing
//      to `<workspaceId>-codex.sock`, and
//   2. CodexEventReceiver normalizing a real notify payload.
//
// The only thing it does NOT prove is the real codex binary actually invoking
// `notify` per turn — that needs an installed/authed codex in a PTY and lives in
// the gated `scripts/codex-events-e2e.mjs` (pnpm e2e:codex-events). The spec's
// 2026-06-11 feasibility table already hand-verified real notify fires, so
// substituting a faithful real-shim invocation here is an honest proof of our
// chain.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTurnEventListener } from "../packages/cli/src/runtime/mount-turn-event-listener.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";

// Mirror the shim's workspace-id derivation so the listener binds the SAME
// socket the shim will independently compute from the payload's cwd.
function wsId(cwd: string): string {
	return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16);
}

// Node 26 runs .ts directly via --experimental-strip-types — same mechanism as
// test/turn-event-shim.test.ts, so the smoke needs no built dist.
const shimPath = join(
	__dirname,
	"..",
	"packages",
	"cli",
	"src",
	"bin",
	"turn-event-shim.ts",
);

describe("codex turn-event smoke: real shim (final argv) → listener → relay → delivered", () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => {
		if (close) await close();
		close = undefined;
	});

	it("a correlated codex notify payload delivers a handback and writes a delivered diagnostics row", async () => {
		// Keep the socket dir path SHORT: the Unix-domain socket lands at
		// `<socketsDir>/<16-hex>-codex.sock` and macOS caps socket paths at ~104
		// chars (the reason workspaceId is sliced to 16 hex). A nested `sockets/`
		// subdir under a long $TMPDIR mkdtemp overflows the cap, so use the mkdtemp
		// dir directly as the socket dir and a short prefix.
		const socketsDir = mkdtempSync(join(tmpdir(), "aiwcx-"));
		const logsDir = join(socketsDir, "logs");
		mkdirSync(logsDir, { recursive: true });
		// The shim derives workspaceId from realpath(cwd), so the cwd must be a real
		// directory (mirrors the shim test's use of a realpath'd temp dir).
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "aiwcx-ws-")));

		const requestText = "Please produce the review matrix.";
		const message = "Review matrix rows and columns, all requirements assessed.";

		// Accepted, autonomous codex handoff awaiting handback. scrapedTurnText
		// contains the message so codex's output-corroboration gate (§4.2) passes —
		// the recipe proven in test/relay-turn-event-relevance.test.ts.
		const h = makeRelayHarness({
			acceptedHandoff: {
				handoffId: "hf_codex_smoke",
				senderAgent: "claude",
				targetAgent: "codex",
				requestText,
				collabId: "c",
				status: "accepted",
			},
			autonomous: true,
			scrapedTurnText: `${message} (plus extra pane scrape words)`,
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		const listener = await createTurnEventListener({
			socketsDir,
			workspaceId: wsId(cwd),
			provider: "codex",
			onEvent: (e) => void relay.handleTurnEvent(e),
		});
		close = listener.close;

		// The real codex notify payload, passed to the shim as the FINAL argv.
		const codexPayload = JSON.stringify({
			type: "agent-turn-complete",
			"thread-id": "thread-smoke",
			"turn-id": "turn-1",
			cwd,
			client: "codex-tui",
			"input-messages": [requestText],
			"last-assistant-message": message,
		});

		// Spawn the REAL shim exactly as codex does: -c notify program invoked with
		// the event JSON appended as the final argv.
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					shimPath,
					"--provider",
					"codex",
					"--socket-dir",
					socketsDir,
					"--log-dir",
					logsDir,
					codexPayload,
				],
				{ stdio: ["ignore", "inherit", "inherit"] },
			);
			child.on("exit", () => resolve());
			child.on("error", reject);
		});

		// Let the listener receive + the relay's handleTurnEvent settle. Codex uses
		// settle-on-last, so a clean corroborated candidate is HELD, not delivered
		// on arrival.
		await new Promise((r) => setTimeout(r, 150));

		// The shim routed to `<workspaceId>-codex.sock` and connected — proving the
		// codex final-argv read + socket routing leg end-to-end.
		const logFile = readdirSync(logsDir).find((f) => f.startsWith("turn-events-"));
		expect(logFile, "shim should append an arrival-log line").toBeDefined();
		const logLine = JSON.parse(
			readFileSync(join(logsDir, logFile!), "utf8").trim(),
		) as { provider: string; connect: string; socket: string };
		expect(logLine.provider).toBe("codex");
		expect(logLine.connect).toBe("ok");
		expect(logLine.socket.endsWith(`${wsId(cwd)}-codex.sock`)).toBe(true);

		// Held, not yet delivered (settle-on-last).
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(relay.isCopyFallbackArmed()).toBe(false); // corroboration passed, not a fallback

		// Settle on quiescence → deliver the codex final message.
		relay.settleHeldTurnEvent("hf_codex_smoke");

		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.handoffBackCalls[0]!.requestText).toContain("Review matrix");
		const last = h.turnEventDiagnostics.at(-1)!;
		expect(last.action).toBe("delivered");
		expect(last.provider).toBe("codex");
		expect(last.fidelityVerdict).toBe("clean");
	});
});
