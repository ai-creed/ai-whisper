import { describe, expect, it } from "vitest";
import { mockProviderReplySchema } from "@ai-whisper/shared";
import { mapTurnToReply } from "../packages/adapter-ai-ezio/src/map-reply.ts";

describe("mapTurnToReply", () => {
	it("non-empty content → kind answer, content preserved, schema-valid", () => {
		const reply = mapTurnToReply({ ok: true, content: "the answer" });
		expect(() => mockProviderReplySchema.parse(reply)).not.toThrow();
		expect(reply).toMatchObject({ kind: "answer", content: "the answer", transitionIntent: null });
	});

	it("empty content with NO error → answer with non-empty fallback (schema-valid)", () => {
		const reply = mapTurnToReply({ ok: true, content: "" });
		expect(() => mockProviderReplySchema.parse(reply)).not.toThrow();
		expect(reply.kind).toBe("answer");
		expect(reply.content.length).toBeGreaterThanOrEqual(1);
	});

	it("error turn → kind failure, error text as content (schema-valid)", () => {
		const reply = mapTurnToReply({ ok: false, error: "engine blew up" });
		expect(() => mockProviderReplySchema.parse(reply)).not.toThrow();
		expect(reply).toMatchObject({ kind: "failure", content: "engine blew up", transitionIntent: "failed" });
	});

	it("error turn with empty message → failure with non-empty fallback", () => {
		const reply = mapTurnToReply({ ok: false, error: "" });
		expect(() => mockProviderReplySchema.parse(reply)).not.toThrow();
		expect(reply.kind).toBe("failure");
		expect(reply.content.length).toBeGreaterThanOrEqual(1);
	});
});
