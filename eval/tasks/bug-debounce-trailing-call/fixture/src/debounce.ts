export interface DebounceOptions {
	leading?: boolean;
	trailing?: boolean;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
}

export interface Debounced<T extends unknown[]> {
	(...args: T): void;
	cancel(): void;
	flush(): void;
}

/**
 * Delays `fn` until `waitMs` have passed without another call. With `leading`
 * the first call of a burst also invokes `fn` immediately; with `trailing`
 * (the default) `fn` is invoked once more when the burst ends.
 */
export function debounce<T extends unknown[]>(
	fn: (...args: T) => void,
	waitMs: number,
	opts: DebounceOptions = {},
): Debounced<T> {
	const leading = opts.leading ?? false;
	const trailing = opts.trailing ?? true;
	const setTimer = opts.setTimeout ?? setTimeout;
	const clearTimer = opts.clearTimeout ?? clearTimeout;

	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingArgs: T | undefined;
	let invokedLeading = false;
	let callsSinceLeading = 0;

	function trailingOwed(): boolean {
		if (!trailing || pendingArgs === undefined) return false;
		return !invokedLeading || callsSinceLeading > 0;
	}

	function resetBurst(): void {
		pendingArgs = undefined;
		invokedLeading = false;
		callsSinceLeading = 0;
	}

	function onTimer(): void {
		timer = undefined;
		const args = pendingArgs;
		const owed = trailingOwed();
		resetBurst();
		if (owed && args !== undefined) fn(...args);
	}

	function debounced(...args: T): void {
		const startingBurst = timer === undefined;
		if (!invokedLeading) pendingArgs = args;
		if (timer !== undefined) clearTimer(timer);
		timer = setTimer(onTimer, waitMs);
		if (startingBurst && leading) {
			fn(...args);
			invokedLeading = true;
		} else if (invokedLeading) {
			callsSinceLeading++;
		}
	}

	debounced.cancel = (): void => {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
		invokedLeading = false;
		callsSinceLeading = 0;
	};

	debounced.flush = (): void => {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
		const args = pendingArgs;
		const owed = trailingOwed();
		resetBurst();
		if (owed && args !== undefined) fn(...args);
	};

	return debounced;
}
