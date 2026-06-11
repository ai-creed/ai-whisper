import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTurnEventListener,
	sweepOrphanSockets,
} from "../packages/cli/src/runtime/mount-turn-event-listener.ts";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";

function sendEnvelope(socketPath: string, envelope: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const c = connect(socketPath, () =>
			c.write(JSON.stringify(envelope), () => c.end()),
		);
		c.on("close", () => resolve());
		c.on("error", reject);
	});
}

describe("mount-turn-event-listener", () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => {
		if (close) await close();
		close = undefined;
	});

	it("runs the claude EventReceiver on the raw envelope — reading inputMessages from the transcript mount-side — and unlinks on close", async () => {
		const socketsDir = mkdtempSync(join(tmpdir(), "aiw-listen-"));
		// A REAL transcript JSONL with a user message. The receiver reads it
		// mount-side (the shim never parses transcripts) → inputMessages populated.
		const transcript = join(
			mkdtempSync(join(tmpdir(), "aiw-tr-")),
			"t.jsonl",
		);
		writeFileSync(
			transcript,
			JSON.stringify({ role: "user", message: { content: "produce the matrix" } }) +
				"\n",
		);

		const got: TurnEvent[] = [];
		const listener = await createTurnEventListener({
			socketsDir,
			workspaceId: "ws9",
			provider: "claude",
			onEvent: (e) => got.push(e),
		});
		close = listener.close;
		expect(existsSync(listener.socketPath)).toBe(true);

		const rawClaude = JSON.stringify({
			session_id: "s",
			cwd: "/r",
			last_assistant_message: "the answer",
			transcript_path: transcript,
		});
		await sendEnvelope(listener.socketPath, {
			provider: "claude",
			raw: rawClaude,
			receivedAt: "2026-06-11T00:00:00.000Z",
		});
		await new Promise((r) => setTimeout(r, 50));

		expect(got).toHaveLength(1);
		expect(got[0]!.message).toBe("the answer");
		// The KEY assertion: transcript-first correlation works in the REAL path.
		expect(got[0]!.inputMessages).toEqual(["produce the matrix"]);
		expect(got[0]!.receivedAt).toBe("2026-06-11T00:00:00.000Z");

		await listener.close();
		close = undefined;
		expect(existsSync(listener.socketPath)).toBe(false);
	});

	it("sweepOrphanSockets removes a stale socket file with no live listener", () => {
		const socketsDir = mkdtempSync(join(tmpdir(), "aiw-orphan-"));
		const orphan = join(socketsDir, "deadws-claude.sock");
		writeFileSync(orphan, "");
		const removed = sweepOrphanSockets(socketsDir);
		expect(removed).toContain(orphan);
		expect(existsSync(orphan)).toBe(false);
	});
});
