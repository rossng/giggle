// Browser storage for small JSON values. Every access is wrapped: storage can be missing,
// full or blocked (private windows, disabled site data), and the app must work without it.

/** The part of the Web Storage API we use; tests pass a Map-backed fake. */
export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** `localStorage`, or null when the browser won't give us one. */
export function browserStorage(): KeyValueStorage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

/** The parsed value under `key`, or undefined if absent, unreadable or not JSON. */
export function readJson(key: string, storage: KeyValueStorage | null = browserStorage()): unknown {
	try {
		const text = storage?.getItem(key);
		return text == null ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Stores `value` as JSON; false if it couldn't be written. */
export function writeJson(
	key: string,
	value: unknown,
	storage: KeyValueStorage | null = browserStorage()
): boolean {
	try {
		if (!storage) return false;
		storage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

/** A Map-backed storage, for tests. */
export function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key)
	};
}
