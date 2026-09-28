import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canKeepScreenOn, LINGER_MS, ScreenWake, type WakeLockHost } from './wake-lock';

class FakeSentinel {
	released = false;
	#listeners: (() => void)[] = [];
	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		for (const fn of this.#listeners) fn();
	}
	addEventListener(_type: 'release', fn: () => void): void {
		this.#listeners.push(fn);
	}
}

function fakeHost() {
	const sentinels: FakeSentinel[] = [];
	const listeners = new Set<() => void>();
	let refuse = false;
	const doc = {
		visibilityState: 'visible' as DocumentVisibilityState,
		addEventListener: (_: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
	};
	const host = {
		wakeLock: {
			request: async () => {
				if (refuse) throw new Error('NotAllowedError');
				const s = new FakeSentinel();
				sentinels.push(s);
				return s;
			}
		},
		document: doc
	} as unknown as WakeLockHost;
	return {
		host,
		sentinels,
		listeners,
		refuse: (on: boolean) => (refuse = on),
		/** The page hidden (the browser drops the lock) or shown again. */
		setVisible(visible: boolean) {
			doc.visibilityState = visible ? 'visible' : 'hidden';
			if (!visible) for (const s of sentinels) void s.release();
			for (const fn of listeners) fn();
		}
	};
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('keeping the screen on', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('is offered only where the browser has a wake lock', () => {
		expect(canKeepScreenOn({})).toBe(false);
		expect(canKeepScreenOn(fakeHost().host)).toBe(true);
	});

	it('holds the lock while playing, and through a short gap', async () => {
		const f = fakeHost();
		const wake = new ScreenWake(f.host);
		wake.set(true);
		await settle();
		expect(wake.held).toBe(true);

		wake.set(false); // a track changing over
		await vi.advanceTimersByTimeAsync(LINGER_MS / 2);
		wake.set(true);
		await vi.advanceTimersByTimeAsync(LINGER_MS);
		expect(wake.held).toBe(true);
		expect(f.sentinels).toHaveLength(1);

		wake.set(false);
		await vi.advanceTimersByTimeAsync(LINGER_MS);
		expect(wake.held).toBe(false);
		expect(f.sentinels[0].released).toBe(true);
	});

	it('asks again when the page is visible again', async () => {
		const f = fakeHost();
		const wake = new ScreenWake(f.host);
		wake.set(true);
		await settle();
		f.setVisible(false);
		expect(wake.held).toBe(false);
		f.setVisible(true);
		await settle();
		expect(wake.held).toBe(true);
		expect(f.sentinels).toHaveLength(2);
	});

	it("doesn't ask while hidden or unwanted, and survives a refusal", async () => {
		const f = fakeHost();
		const wake = new ScreenWake(f.host);
		f.setVisible(true); // not wanted: nothing asked
		f.setVisible(false);
		wake.set(true);
		await settle();
		expect(f.sentinels).toHaveLength(0);

		f.refuse(true);
		f.setVisible(true);
		await settle();
		expect(wake.held).toBe(false);

		f.refuse(false);
		wake.set(true);
		await settle();
		expect(wake.held).toBe(true);
	});

	it('lets go and stops listening when destroyed', async () => {
		const f = fakeHost();
		const wake = new ScreenWake(f.host);
		wake.set(true);
		await settle();
		wake.destroy();
		expect(wake.held).toBe(false);
		expect(f.listeners.size).toBe(0);
	});

	it('drops a lock granted after the music stopped for good', async () => {
		const f = fakeHost();
		const wake = new ScreenWake(f.host);
		wake.set(true);
		wake.destroy(); // before the request resolves
		await settle();
		expect(wake.held).toBe(false);
		expect(f.sentinels[0].released).toBe(true);
	});
});
