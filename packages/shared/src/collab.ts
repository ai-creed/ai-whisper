import { z } from "zod";
import { collabIdSchema } from "./id.js";
import { collabStates } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const collabSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	collabId: collabIdSchema,
	workspaceRoot: z.string().min(1),
	displayName: z.string().min(1),
	status: z.enum(collabStates),
	createdAt: z.string().datetime({ offset: true }),
	updatedAt: z.string().datetime({ offset: true }),
	// Run-ledger: null while the collab is live/addressable; a timestamp once purge
	// has archived its runtime rows (Task 1, schema v8). History is read-only once set.
	archivedAt: z.string().datetime({ offset: true }).nullable().default(null),
	orchestratorEnabled: z.boolean().default(false),
	orchestratorMaxRounds: z.number().int().min(1).default(3),
});

export type Collab = z.infer<typeof collabSchema>;
