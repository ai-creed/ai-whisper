import { createServer, connect, type Server } from "node:net";
import { mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { turnEventSocketPath } from "./turn-event-socket-path.js";
import { ClaudeEventReceiver, CodexEventReceiver } from "./event-receiver.js";
import { AgyEventReceiver, type AgyAdoptionMode } from "./agy-event-receiver.js";
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
	/** agy heartbeat / tool-in-flight signal (no-op for claude/codex). */
	onActivity?: (info: { toolInFlight: boolean }) => void;
	/** agy adoption config; required when provider === "agy". */
	agy?: { mode: AgyAdoptionMode; mountCwd: string; pinnedConversationId?: string };
}): Promise<TurnEventListener> {
	mkdirSync(input.socketsDir, { recursive: true });
	const socketPath = turnEventSocketPath(
		input.socketsDir,
		input.workspaceId,
		input.provider,
	);
	// One receiver per listener; the agy receiver is stateful (adopted id + tools
	// in flight) and must persist across hook connections.
	const stdReceiver =
		input.provider === "codex"
			? new CodexEventReceiver()
			: input.provider === "claude"
				? new ClaudeEventReceiver()
				: null;
	const agyReceiver =
		input.provider === "agy"
			? new AgyEventReceiver({
					mode: input.agy?.mode ?? "global",
					mountCwd: input.agy?.mountCwd ?? ".",
					...(input.agy?.pinnedConversationId !== undefined
						? { pinnedConversationId: input.agy.pinnedConversationId }
						: {}),
				})
			: null;
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
					event?: string;
				};
				if (
					typeof envelope.raw !== "string" ||
					typeof envelope.receivedAt !== "string"
				)
					return;
				if (agyReceiver) {
					const obs = agyReceiver.observe(
						envelope.raw,
						envelope.receivedAt,
						typeof envelope.event === "string" ? envelope.event : "",
					);
					if (obs.kind === "turn-end") input.onEvent(obs.event);
					else if (obs.kind === "heartbeat")
						input.onActivity?.({ toolInFlight: obs.toolInFlight });
					return;
				}
				const event = stdReceiver?.parse(envelope.raw, envelope.receivedAt) ?? null;
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
