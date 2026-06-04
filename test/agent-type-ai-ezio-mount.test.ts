import { describe, expect, it } from "vitest";
import {
	agentTypes,
	sessionBindingSchema,
	attachClaimSchema,
	brokerSchemaVersion,
} from "@ai-whisper/shared";

describe("ai-ezio agent-type widening (mount-registration path)", () => {
	it("agentTypes includes ai-ezio", () => {
		expect(agentTypes).toContain("ai-ezio");
	});

	it("sessionBindingSchema accepts agentType ai-ezio", () => {
		expect(() =>
			sessionBindingSchema.parse({
				version: brokerSchemaVersion,
				collabId: "collab_x",
				agentType: "ai-ezio",
				bindingState: "bound",
				activeSessionId: null,
				bindingSource: null,
				targetTtyPath: null,
				pendingClaimId: null,
				pendingClaimExpiresAt: null,
				updatedAt: "2026-06-04T00:00:00.000Z",
			}),
		).not.toThrow();
	});

	it("attachClaimSchema accepts agentType ai-ezio", () => {
		expect(() =>
			attachClaimSchema.parse({
				version: brokerSchemaVersion,
				claimId: "claim_x",
				collabId: "collab_x",
				agentType: "ai-ezio",
				mode: "attach",
				secret: "s",
				status: "pending",
				createdAt: "2026-06-04T00:00:00.000Z",
				expiresAt: "2026-06-04T00:05:00.000Z",
				consumedAt: null,
			}),
		).not.toThrow();
	});
});
