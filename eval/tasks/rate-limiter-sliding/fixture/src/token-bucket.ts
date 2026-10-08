export interface TokenBucketOptions {
	capacity: number;
	refillPerSecond: number;
	now: () => number;
}

export class TokenBucket {
	private tokens: number;
	private lastRefillMs: number;
	private readonly capacity: number;
	private readonly refillPerSecond: number;
	private readonly now: () => number;

	constructor({ capacity, refillPerSecond, now }: TokenBucketOptions) {
		if (!(capacity > 0) || !(refillPerSecond > 0)) {
			throw new RangeError("capacity and refillPerSecond must be positive");
		}
		this.capacity = capacity;
		this.refillPerSecond = refillPerSecond;
		this.now = now;
		this.tokens = capacity;
		this.lastRefillMs = now();
	}

	private refill(): void {
		const current = this.now();
		const elapsedMs = current - this.lastRefillMs;
		if (elapsedMs > 0) {
			this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
			this.lastRefillMs = current;
		}
	}

	tryRemove(n = 1): boolean {
		this.refill();
		if (this.tokens < n) return false;
		this.tokens -= n;
		return true;
	}
}
