import { join } from "node:path";
import type { TurnEventProvider } from "./turn-event.js";

export function turnEventSocketPath(
	socketDir: string,
	workspaceId: string,
	provider: TurnEventProvider,
): string {
	return join(socketDir, `${workspaceId}-${provider}.sock`);
}
