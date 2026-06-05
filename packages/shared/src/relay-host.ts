import { z } from "zod";

export const relayTargets = ["codex", "claude", "ezio", "pull"] as const;

export const relayDirectiveSchema = z.object({
	raw: z.string().min(1),
	target: z.enum(relayTargets),
	forceNewThread: z.boolean(),
	instruction: z.string(),
});

export type RelayDirective = z.infer<typeof relayDirectiveSchema>;
