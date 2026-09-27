import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KokoroVoice } from './kokoro';
import type { KokoroReply, KokoroRequest } from './protocol';

/** Stands in for kokoro.worker.ts: records requests; the test replies. */
class FakeWorker {
	onmessage: ((event: MessageEvent<KokoroReply>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	sent: KokoroRequest[] = [];

	postMessage(msg: KokoroRequest): void {
		this.sent.push(msg);
	}

	reply(msg: KokoroReply): void {
		this.onmessage?.({ data: msg } as MessageEvent<KokoroReply>);
	}

	/** The lines sent to be said, in order. */
	get said(): string[] {
		return this.sent.flatMap((m) => (m.type === 'say' ? [m.text] : []));
	}

	/** Finishes the line the worker is on. */
	finish(): void {
		const say = this.sent.filter((m) => m.type === 'say').at(-1);
		if (say?.type !== 'say') throw new Error('nothing to finish');
		this.reply({
			type: 'audio',
			id: say.id,
			samples: new Float32Array(24_000),
			sampleRate: 24_000,
			ms: 900,
			phonemeMs: 10,
			phonemes: say.text
		});
	}
}

function setup() {
	const worker = new FakeWorker();
	const voice = new KokoroVoice({
		lexiconUrl: 'data:application/json,null',
		worker: () => worker as unknown as Worker
	});
	const ready = () => {
		void voice.load();
		worker.reply({ type: 'ready', device: 'webgpu', dtype: 'fp32', ms: 1 });
	};
	return { worker, voice, ready };
}

const settled = (p: Promise<unknown>) =>
	p.then(
		() => 'rendered',
		(e: Error) => e.name
	);

describe('KokoroVoice queue', () => {
	beforeEach(() => void vi.spyOn(console, 'info').mockImplementation(() => {}));
	afterEach(() => vi.restoreAllMocks());

	it('gives the worker one line at a time, urgent ones before those prepared ahead', async () => {
		const { worker, voice, ready } = setup();
		const a = voice.render('Prepared one.', 'bm_fable');
		voice.render('Prepared two.', 'bm_fable');
		voice.render('Say this now.', 'bm_fable', { urgent: true });
		expect(worker.said).toEqual([]); // not loaded yet
		ready();
		expect(worker.said).toEqual(['Say this now.']);
		expect(voice.waiting).toEqual(['Prepared one.', 'Prepared two.']);
		worker.finish();
		expect(worker.said).toEqual(['Say this now.', 'Prepared one.']);
		// Asked for again once it's about to be said: moves up past the other prepared line.
		voice.render('Prepared two.', 'bm_fable', { urgent: true });
		voice.render('Now as well.', 'bm_fable', { urgent: true });
		expect(voice.waiting).toEqual(['Prepared two.', 'Now as well.']);
		worker.finish();
		expect((await a).ms).toBe(900);
		expect((await voice.render('Prepared one.', 'bm_fable')).ms).toBe(0); // cached
	});

	it('drops a line nobody wants any more before the worker starts on it', async () => {
		const { worker, voice, ready } = setup();
		ready();
		const old = new AbortController();
		const first = voice.render('On the way.', 'bm_fable', { signal: old.signal });
		const second = voice.render('Skipped past.', 'bm_fable', { signal: old.signal });
		const kept = voice.render('Still wanted.', 'bm_fable');
		old.abort();
		expect(voice.waiting).toEqual(['Still wanted.']);
		expect(await settled(second)).toBe('AbortError');
		// The one the worker already had finishes, and stays cached.
		worker.finish();
		expect(await settled(first)).toBe('rendered');
		expect((await voice.render('On the way.', 'bm_fable')).ms).toBe(0);
		worker.finish();
		expect(await settled(kept)).toBe('rendered');
		// Asking again for the dropped one renders it afresh.
		const again = voice.render('Skipped past.', 'bm_fable');
		expect(worker.said.at(-1)).toBe('Skipped past.');
		worker.finish();
		expect((await again).ms).toBe(900);
		expect(worker.said).toEqual(['On the way.', 'Still wanted.', 'Skipped past.']);
	});

	it('keeps a line while anyone still wants it, back behind the urgent ones', async () => {
		const { worker, voice, ready } = setup();
		ready();
		voice.render('Busy.', 'bm_fable');
		const prep = new AbortController();
		const now = new AbortController();
		const line = voice.render('Next artist.', 'bf_isabella', { signal: prep.signal });
		const urgent = voice.render('Next artist.', 'bf_isabella', {
			urgent: true,
			signal: now.signal
		});
		voice.render('Another intro.', 'bm_fable', { urgent: true });
		expect(voice.waiting).toEqual(['Next artist.', 'Another intro.']);
		now.abort(); // the listener skipped on again, but it's still prepared for later
		expect(voice.waiting).toEqual(['Another intro.', 'Next artist.']);
		prep.abort(); // and now it isn't
		expect(voice.waiting).toEqual(['Another intro.']);
		expect(await settled(line)).toBe('AbortError');
		expect(await settled(urgent)).toBe('AbortError');
		expect(worker.said).toEqual(['Busy.']);
	});

	it("doesn't queue a line whose asker has already given up", async () => {
		const { worker, voice, ready } = setup();
		ready();
		const gone = AbortSignal.abort();
		expect(await settled(voice.render('Too late.', 'bm_fable', { signal: gone }))).toBe(
			'AbortError'
		);
		expect(worker.said).toEqual([]);
		expect(voice.waiting).toEqual([]);
	});
});
