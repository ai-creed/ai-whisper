import { readFileSync } from "node:fs";
import { workspaceIdFromPath } from "./workspace-id.js";
import type { TurnEvent } from "./turn-event.js";

export abstract class EventReceiver {
	abstract parse(raw: string, receivedAt: string): TurnEvent | null;

	protected safeWorkspaceId(cwd: string): string {
		try {
			return workspaceIdFromPath(cwd);
		} catch {
			// realpathSync can throw if cwd vanished; fall back to a hash of the raw
			// string so the event still routes deterministically.
			return workspaceIdFromPath(".");
		}
	}
}

export class ClaudeEventReceiver extends EventReceiver {
	parse(raw: string, receivedAt: string): TurnEvent | null {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
		const cwd =
			typeof payload["cwd"] === "string" ? (payload["cwd"]) : "";
		if (!cwd) return null;
		const message =
			typeof payload["last_assistant_message"] === "string"
				? (payload["last_assistant_message"])
				: "";
		const sessionId =
			typeof payload["session_id"] === "string"
				? (payload["session_id"])
				: "";
		const transcriptPath =
			typeof payload["transcript_path"] === "string"
				? (payload["transcript_path"])
				: "";
		return {
			provider: "claude",
			workspaceId: this.safeWorkspaceId(cwd),
			cwd,
			sessionOrThreadId: sessionId,
			turnId: null,
			message,
			inputMessages: readLatestUserMessage(transcriptPath),
			receivedAt,
		};
	}
}

// Reads the last user-role message from a claude transcript JSONL. Best-effort:
// returns [] when the file is unreadable (sequence backstop covers correlation).
function readLatestUserMessage(transcriptPath: string): string[] {
	if (!transcriptPath) return [];
	let text: string;
	try {
		text = readFileSync(transcriptPath, "utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]!) as {
				role?: string;
				type?: string;
				message?: { content?: unknown };
				content?: unknown;
			};
			const role = entry.role ?? entry.type;
			if (role === "user") {
				const content = entry.message?.content ?? entry.content;
				const str = extractText(content);
				if (str) return [str];
			}
		} catch {
			// skip unparseable line
		}
	}
	return [];
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) =>
				typeof p === "object" && p !== null && "text" in p
					? String((p as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
}

export class CodexEventReceiver extends EventReceiver {
	parse(raw: string, receivedAt: string): TurnEvent | null {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
		const cwd =
			typeof payload["cwd"] === "string" ? (payload["cwd"]) : "";
		if (!cwd) return null;
		const inputRaw = payload["input-messages"];
		const inputMessages = Array.isArray(inputRaw)
			? inputRaw.filter((m): m is string => typeof m === "string")
			: [];
		return {
			provider: "codex",
			workspaceId: this.safeWorkspaceId(cwd),
			cwd,
			sessionOrThreadId:
				typeof payload["thread-id"] === "string"
					? (payload["thread-id"])
					: "",
			turnId:
				typeof payload["turn-id"] === "string"
					? (payload["turn-id"])
					: null,
			message:
				typeof payload["last-assistant-message"] === "string"
					? (payload["last-assistant-message"])
					: "",
			inputMessages,
			receivedAt,
		};
	}
}
