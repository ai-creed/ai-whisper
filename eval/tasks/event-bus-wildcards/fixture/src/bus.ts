export type Handler = (payload: unknown, topic: string) => void;

export class EventBus {
	private readonly handlers = new Map<string, Set<Handler>>();

	on(topic: string, handler: Handler): () => void {
		let set = this.handlers.get(topic);
		if (!set) {
			set = new Set();
			this.handlers.set(topic, set);
		}
		set.add(handler);
		return () => this.off(topic, handler);
	}

	emit(topic: string, payload: unknown): void {
		const set = this.handlers.get(topic);
		if (!set) return;
		for (const handler of [...set]) {
			handler(payload, topic);
		}
	}

	off(topic: string, handler: Handler): void {
		const set = this.handlers.get(topic);
		if (!set) return;
		set.delete(handler);
		if (set.size === 0) this.handlers.delete(topic);
	}
}
