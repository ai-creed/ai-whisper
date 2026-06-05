import { EventEmitter } from "node:events";
import type { AgentType } from "@ai-whisper/shared";

export type BrokerEventMap = {
	"chain.resolved": { collabId: string; chainId: string };
	"chain.escalated": {
		collabId: string;
		chainId: string;
		handoffId: string;
		reason: string;
	};
	"workflow.created": { workflowId: string };
	"workflow.phase-started": {
		workflowId: string;
		phaseIndex: number;
		phaseName: string;
		chainId: string;
		phaseRunId: string;
		implementer: AgentType;
		reviewer: AgentType;
	};
	"workflow.round-started": {
		workflowId: string;
		chainId: string;
		phaseRunId: string;
		roundNumber: number;
		handoffStep: "review" | "fix" | "implement" | "execute";
		sender: AgentType;
		target: AgentType;
	};
	"workflow.phase-done": {
		workflowId: string;
		phaseIndex: number;
		phaseName: string;
	};
	"workflow.halted": { workflowId: string; reason: string };
	"workflow.canceled": { workflowId: string; reason: string };
	"workflow.done": { workflowId: string };
	"workflow.resumed": { workflowId: string; phaseIndex: number };
	"workflow.paused": { workflowId: string };
};

export type BrokerEventName = keyof BrokerEventMap;

export interface BrokerEventBus {
	on<E extends BrokerEventName>(
		event: E,
		handler: (payload: BrokerEventMap[E]) => void,
	): () => void;
	emit<E extends BrokerEventName>(event: E, payload: BrokerEventMap[E]): void;
}

export function createBrokerEventBus(): BrokerEventBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(50);
	return {
		on(event, handler) {
			const wrapped = (payload: unknown): void => {
				try {
					// safe: on/emit generics constrain E's payload; EventEmitter is untyped.
					handler(payload as never);
				} catch (error) {
					console.error(`[broker-event-bus] handler for ${String(event)} threw`, error);
				}
			};
			emitter.on(event, wrapped);
			return () => {
				emitter.off(event, wrapped);
			};
		},
		emit(event, payload) {
			emitter.emit(event, payload);
		},
	};
}
