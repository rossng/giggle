import { describe, expect, it } from 'vitest';
import type { KokoroStatus, Rendered } from '$lib/voice/kokoro';
import {
	ClipSpeaker,
	englishVoices,
	KokoroSpeaker,
	pickVoice,
	sentences,
	type LiveVoice,
	type SpokenLine
} from './speaker';

const v = (name: string, lang: string) => ({ name, lang });
const VOICES = [
	v('Samantha', 'en-US'),
	v('Amélie', 'fr-CA'),
	v('Serena', 'en-GB'),
	v('Daniel (English (United Kingdom))', 'en-GB'),
	v('Karen', 'en-AU'),
	v('Moira', 'en_IE')
];

describe('voices', () => {
	it('lists English voices, British first', () => {
		expect(englishVoices(VOICES).map((x) => x.name)).toEqual([
			'Daniel (English (United Kingdom))',
			'Serena',
			'Karen',
			'Moira',
			'Samantha'
		]);
	});

	it('picks the wanted voice, else Daniel, else any British one, else English', () => {
		expect(pickVoice(VOICES, 'Karen')?.name).toBe('Karen');
		expect(pickVoice(VOICES, 'Gone')?.name).toBe('Daniel (English (United Kingdom))');
		expect(pickVoice(VOICES.filter((x) => !x.name.startsWith('Daniel')))?.name).toBe('Serena');
		expect(pickVoice([v('Zed', 'en-GB'), v('Alex', 'en-US')])?.name).toBe('Zed');
		expect(pickVoice([v('Alex', 'en-US')])?.name).toBe('Alex');
		expect(pickVoice([v('Amélie', 'fr-CA')])).toBeNull();
	});
});

describe('ClipSpeaker', () => {
	/** A stand-in <audio>: plays instantly, or fails. */
	function fakeAudio(fail = false) {
		const listeners: Record<string, (() => void)[]> = {};
		const audio = {
			src: '',
			played: [] as string[],
			addEventListener: (type: string, f: () => void) => (listeners[type] ??= []).push(f),
			removeEventListener: (type: string, f: () => void) =>
				(listeners[type] = (listeners[type] ?? []).filter((g) => g !== f)),
			pause: () => {},
			play() {
				audio.played.push(audio.src);
				queueMicrotask(() => (listeners[fail ? 'error' : 'ended'] ?? []).forEach((f) => f()));
				return Promise.resolve();
			}
		};
		return audio;
	}
	function liveVoice() {
		const said: string[] = [];
		const prepared: string[] = [];
		return {
			said,
			prepared,
			speaker: {
				speak: async (line: SpokenLine) => void said.push(line.text),
				prepare: (line: SpokenLine) => void prepared.push(line.text),
				stop: () => {}
			}
		};
	}
	const line: SpokenLine = {
		text: 'Djavan, a Brazilian singer-songwriter. They play Paradiso tonight.',
		kind: 'intro',
		artistKey: 'mb:1',
		seconds: 8,
		clip: { url: '/data/voice/a.mp3', seconds: 5, spoken: 'They play Paradiso tonight.' }
	};

	it('plays the clip, then says only the gig line', async () => {
		const audio = fakeAudio();
		const live = liveVoice();
		const s = new ClipSpeaker(live.speaker, () => audio as unknown as HTMLAudioElement);
		await s.speak(line, new AbortController().signal);
		expect(audio.played).toEqual(['/data/voice/a.mp3']);
		expect(live.said).toEqual(['They play Paradiso tonight.']);
	});

	it('gets the gig line ready while the clip plays', () => {
		const live = liveVoice();
		const s = new ClipSpeaker(live.speaker, () => fakeAudio() as unknown as HTMLAudioElement);
		s.prepare(line);
		s.prepare({ ...line, clip: undefined });
		expect(live.prepared).toEqual(['They play Paradiso tonight.', line.text]);
	});

	it('says the whole line when the clip fails', async () => {
		const live = liveVoice();
		const s = new ClipSpeaker(live.speaker, () => fakeAudio(true) as unknown as HTMLAudioElement);
		await s.speak(line, new AbortController().signal);
		expect(live.said).toEqual([line.text]);
	});

	it('passes lines without a clip straight through', async () => {
		const audio = fakeAudio();
		const live = liveVoice();
		const s = new ClipSpeaker(live.speaker, () => audio as unknown as HTMLAudioElement);
		await s.speak({ ...line, clip: undefined }, new AbortController().signal);
		expect(audio.played).toEqual([]);
		expect(live.said).toEqual([line.text]);
	});
});

describe('KokoroSpeaker', () => {
	const line: SpokenLine = {
		text: 'They play Paradiso tonight.',
		kind: 'intro',
		artistKey: 'mb:1',
		seconds: 3
	};
	const signal = () => new AbortController().signal;

	function fakes(
		options: { status?: KokoroStatus; ms?: number; fail?: (text: string) => boolean } = {}
	) {
		const log: string[] = [];
		const voice: LiveVoice & { state: { status: KokoroStatus } } = {
			state: { status: options.status ?? 'ready' },
			load: async () => void log.push('load'),
			render: async (text, v, o) => {
				log.push(`render ${v}${o?.urgent ? ' now' : ''}: ${text}`);
				if (options.fail?.(text)) throw new Error('no');
				const r: Rendered = {
					samples: new Float32Array(1),
					sampleRate: 24000,
					seconds: 3,
					ms: options.ms ?? 1000,
					phonemeMs: 1,
					phonemes: text
				};
				return r;
			},
			play: async (r) => (log.push(`play ${r.phonemes}`), true),
			unlock: () => {},
			stop: () => {}
		};
		const fallback = { speak: async (l: SpokenLine) => void log.push(`web: ${l.text}`), stop() {} };
		const speaker = new KokoroSpeaker(voice, fallback, { voiceFor: async () => 'bm_fable' });
		return { log, voice, speaker };
	}

	it("says lines in the artist's announcer voice", async () => {
		const { log, speaker } = fakes();
		await speaker.speak(line, signal());
		expect(log).toEqual([
			'render bm_fable now: They play Paradiso tonight.',
			'play They play Paradiso tonight.'
		]);
	});

	it('renders every sentence at once and plays them in turn', async () => {
		const { log, speaker } = fakes();
		await speaker.speak({ ...line, text: 'Here’s Nobu. They play Paradiso tonight.' }, signal());
		expect(log).toEqual([
			'render bm_fable now: Here’s Nobu.',
			'render bm_fable now: They play Paradiso tonight.',
			'play Here’s Nobu.',
			'play They play Paradiso tonight.'
		]);
	});

	it('hands the rest of a line to the browser voice when a sentence fails', async () => {
		const { log, speaker } = fakes({ fail: (t) => t.startsWith('They') });
		await speaker.speak(
			{ ...line, text: 'Here’s Nobu. They play Paradiso tonight. It’s free.' },
			signal()
		);
		expect(log.slice(3)).toEqual([
			'play Here’s Nobu.',
			'web: They play Paradiso tonight. It’s free.'
		]);
	});

	it('splits lines into sentences', () => {
		expect(sentences('Here’s Nobu!  They play at 7.30pm… Tickets? €24.')).toEqual([
			'Here’s Nobu!',
			'They play at 7.30pm…',
			'Tickets?',
			'€24.'
		]);
	});

	it('uses the browser voice until the model is ready, and starts loading it', async () => {
		const { log, speaker } = fakes({ status: 'off' });
		await speaker.speak(line, signal());
		expect(log).toEqual(['load', 'web: They play Paradiso tonight.']);
	});

	it('uses the browser voice when rendering fails, or when turned off', async () => {
		const failing = fakes({ fail: () => true });
		await failing.speaker.speak(line, signal());
		expect(failing.log.at(-1)).toBe('web: They play Paradiso tonight.');
		const off = fakes();
		off.speaker.enabled = false;
		await off.speaker.speak(line, signal());
		expect(off.log).toEqual(['web: They play Paradiso tonight.']);
	});

	it('gives up on a device that renders far slower than real time', async () => {
		const { log, speaker } = fakes({ ms: 20_000 });
		await speaker.speak(line, signal());
		expect(speaker.slow).toBe(false); // the first render may be a warm-up
		await speaker.speak(line, signal());
		expect(speaker.slow).toBe(true);
		log.length = 0;
		await speaker.speak(line, signal());
		expect(log).toEqual(['web: They play Paradiso tonight.']);
	});

	it('renders prepared lines ahead', async () => {
		const { log, speaker } = fakes();
		speaker.prepare(line);
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(['render bm_fable: They play Paradiso tonight.']);
	});
});
