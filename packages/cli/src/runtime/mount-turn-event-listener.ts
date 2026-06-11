import { createServer, connect, type Server } from "node:net";
import { mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { turnEventSocketPath } from "./turn-event-socket-path.js";
import { ClaudeEventReceiver, CodexEventReceiver } from "./event-receiver.js";
import type { TurnEvent, TurnEventProvider } from "./turn-event.js";

export type TurnEventListener = {
	socketPath: string;
	close: () => Promise<void>;
};

export async function createTurnEventListener(input: {
	socketsDir: string;
	workspaceId: string;
	provider: TurnEventProvider;
	onEvent: (event: TurnEvent) => void;
}): Promise<TurnEventListener> {
	mkdirSync(input.socketsDir, { recursive: true });
	const socketPath = turnEventSocketPath(
		input.socketsDir,
		input.workspaceId,
		input.provider,
	);
	// The EventReceiver is the SINGLE normalization path (shared with the unit
	// tests in Tasks 6–7). The shim forwards the raw payload; the listener runs
	// the receiver here, mount-side, so claude's transcript_path read happens
	// where fs + JSONL parsing live.
	const receiver =
		input.provider === "codex"
			? new CodexEventReceiver()
			: new ClaudeEventReceiver();
	// Clear a stale socket file left by a crashed prior mount before binding.
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			/* ignore */
		}
	}
	const server: Server = createServer((conn) => {
		let buf = "";
		conn.on("data", (d) => (buf += d.toString("utf8")));
		conn.on("end", () => {
			try {
				const envelope = JSON.parse(buf) as {
					provider?: string;
					raw?: string;
					receivedAt?: string;
				};
				if (
					typeof envelope.raw !== "string" ||
					typeof envelope.receivedAt !== "string"
				)
					return;
				const event = receiver.parse(envelope.raw, envelope.receivedAt);
				if (event) input.onEvent(event);
			} catch {
				// malformed envelope — drop silently; arrival log already recorded it.
			}
		});
		conn.on("error", () => {
			/* a half-open client must never crash the mount */
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					try {
						if (existsSync(socketPath)) unlinkSync(socketPath);
					} catch {
						/* ignore */
					}
					resolve();
				});
			}),
	};
}

// Broker/mount startup sweep: a *.sock with no live listener can be safely
// unlinked. We probe by attempting a connect; ECONNREFUSED/ENOENT ⇒ orphan.
export function sweepOrphanSockets(socketsDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(socketsDir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of entries) {
		if (!name.endsWith(".sock")) continue;
		const full = join(socketsDir, name);
		// Synchronous best-effort: try connect, on failure unlink.
		let alive = false;
		try {
			const probe = connect(full);
			probe.on("connect", () => {
				alive = true;
				probe.destroy();
			});
			probe.on("error", () => {
				/* not alive */
			});
		} catch {
			/* not alive */
		}
		if (!alive) {
			try {
				unlinkSync(full);
				removed.push(full);
			} catch {
				/* ignore */
			}
		}
	}
	return removed;
}
