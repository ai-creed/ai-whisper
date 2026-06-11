import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";

// Workspace-id mirror so the test computes the same socket the shim will target.
function wsId(cwd: string): string {
	return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16);
}

// Node 26 supports --experimental-strip-types for running .ts files directly.
// This is the mechanism available in this repo (no tsx on PATH, no built dist
// at test time, but Node 26 is available).
const shimPath = join(
	__dirname,
	"..",
	"packages",
	"cli",
	"src",
	"bin",
	"turn-event-shim.ts",
);

describe("turn-event-shim", () => {
	let server: Server | undefined;
	afterEach(() => server?.close());

	it("forwards the raw claude payload in an envelope to the mount socket and writes an arrival log", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "aiw-shim-"));
		const socketsDir = join(stateRoot, "sockets");
		const logsDir = join(stateRoot, "logs");
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "aiw-ws-")));
		const sockPath = join(socketsDir, `${wsId(cwd)}-claude.sock`);

		const received: string[] = [];
		await new Promise<void>((resolve) => {
			mkdirSync(socketsDir, { recursive: true });
			server = createServer((conn) => {
				let buf = "";
				conn.on("data", (d) => (buf += d.toString("utf8")));
				conn.on("end", () => {
					received.push(buf);
				});
			});
			server.listen(sockPath, resolve);
		});

		const payload = JSON.stringify({
			session_id: "s1",
			cwd,
			last_assistant_message: "done",
			transcript_path: "/nope.jsonl",
		});

		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					shimPath,
					"--provider",
					"claude",
					"--socket-dir",
					socketsDir,
					"--log-dir",
					logsDir,
				],
				{ stdio: ["pipe", "inherit", "inherit"] },
			);
			child.stdin!.write(payload);
			child.stdin!.end();
			child.on("exit", () => resolve());
			child.on("error", reject);
		});

		// Wait briefly for the server's end event to fire after child exits.
		await new Promise((r) => setTimeout(r, 100));

		// The mount received exactly one envelope carrying the RAW provider payload;
		// normalization (incl. claude transcript read) happens mount-side in the
		// listener via the EventReceiver, NOT in the dependency-free shim.
		expect(received).toHaveLength(1);
		const envelope = JSON.parse(received[0]!);
		expect(envelope.provider).toBe("claude");
		expect(typeof envelope.raw).toBe("string");
		expect(JSON.parse(envelope.raw).last_assistant_message).toBe("done");
		expect(envelope.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// An arrival log line was appended.
		const logFile = readdirSync(logsDir).find((f) => f.startsWith("turn-events-"));
		expect(logFile).toBeDefined();
		const logLine = JSON.parse(
			readFileSync(join(logsDir, logFile!), "utf8").trim(),
		);
		expect(logLine.provider).toBe("claude");
		expect(logLine.connect).toBe("ok");
	});
});
