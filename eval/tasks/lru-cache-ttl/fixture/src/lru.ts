export class LruCache<K, V> {
	private readonly entries = new Map<K, V>();

	constructor(private readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError("capacity must be a positive integer");
		}
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: K): V | undefined {
		if (!this.entries.has(key)) return undefined;
		const value = this.entries.get(key) as V;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.entries.has(key)) {
			this.entries.delete(key);
		} else if (this.entries.size >= this.capacity) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		this.entries.set(key, value);
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}
}
