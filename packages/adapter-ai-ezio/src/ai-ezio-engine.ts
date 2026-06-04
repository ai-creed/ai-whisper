import { Session } from "@ai-ezio/harness";
import type { ProtocolEvent } from "@ai-ezio/protocol";

/** The subset of the harness Session the adapter drives. */
export interface AiEzioEngineSession {
	start(): Promise<unknown>;
	submit(text: string): void;
	submitAndWait(text: string): Promise<{ turnId: string; content: string }>;
	onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
	close(): void;
}

export type CreateEngineSession = (opts: {
	onEvent: (event: ProtocolEvent) => void;
}) => AiEzioEngineSession;

/** Default factory: a real hax-backed harness Session in mounted posture. */
export const defaultCreateEngineSession: CreateEngineSession = ({ onEvent }) =>
	new Session({ onEvent }) as unknown as AiEzioEngineSession;

export type { ProtocolEvent };
