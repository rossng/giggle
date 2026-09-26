import { describe, expect, it } from 'vitest';
import { ClipSpeaker, englishVoices, pickVoice, type SpokenLine } from './speaker';

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
		return {
			said,
			speaker: {
				speak: async (line: SpokenLine) => void said.push(line.text),
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
