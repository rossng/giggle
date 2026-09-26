import { describe, expect, it } from 'vitest';
import { phonemize } from 'phonemizer';
import { announcerFor } from './announcers';
import { normalise } from './audio';
import { Lexicon, possessive } from './lexicon';
import { toPhonemes } from './phonemes';

const LEXICON = new Lexicon([
	{ written: 'Paradiso', ipa: 'pˌaɹədˈiːzəʊ', match_case: false },
	{ written: 'Muziekgebouw', ipa: 'muːzˈiːkhəbˌaʊ', match_case: false },
	{ written: "Muziekgebouw aan 't IJ", ipa: 'muːzˈiːkhəbˌaʊ ɑːn ət ˈaɪ', match_case: false },
	{ written: 'OCCII', ipa: 'ˈɒki', match_case: true },
	{ written: 'Tolhuistuin', ipa: 'tˈɒlhaʊstˌaʊn', match_case: false }
]);

describe('Lexicon (as the pipeline’s voice.py)', () => {
	it('finds names, possessives and case-sensitive entries', () => {
		expect(LEXICON.split("Tonight it's Paradiso's turn, then OCCII and occii.")).toEqual([
			{ text: "Tonight it's " },
			{ text: "Paradiso's", ipa: 'pˌaɹədˈiːzəʊz' },
			{ text: ' turn, then ' },
			{ text: 'OCCII', ipa: 'ˈɒki' },
			{ text: ' and occii.' }
		]);
	});

	it('prefers the longest name and takes curly apostrophes', () => {
		expect(LEXICON.split('They play Muziekgebouw aan ’t IJ on Friday.')).toEqual([
			{ text: 'They play ' },
			{ text: "Muziekgebouw aan 't IJ", ipa: 'muːzˈiːkhəbˌaʊ ɑːn ət ˈaɪ' },
			{ text: ' on Friday.' }
		]);
	});

	it('matches whole words only', () => {
		expect(LEXICON.split('Paradisoesque')).toEqual([{ text: 'Paradisoesque' }]);
	});

	it('gives possessives the right ending', () => {
		expect(possessive('bˈɪmhaʊs')).toBe('bˈɪmhaʊsɪz');
		expect(possessive('mˈɛlkvɛɡ')).toBe('mˈɛlkvɛɡz');
		expect(possessive('ˈɒlɪmpɪk')).toBe('ˈɒlɪmpɪks');
	});

	it('parses the published JSON and ignores junk', () => {
		const lx = Lexicon.parse({ names: [{ written: 'Bimhuis', ipa: 'x', match_case: false }, {}] });
		expect(lx.entries).toHaveLength(1);
		expect(Lexicon.parse(null).entries).toHaveLength(0);
	});
});

describe('toPhonemes', () => {
	it('splices names in and phonemizes the rest', async () => {
		const fake = async (text: string) => [`<${text}>`];
		expect(await toPhonemes('Catch them at Tolhuistuin tonight!', LEXICON, fake)).toBe(
			'<Catch them at> tˈɒlhaʊstˌaʊn <tonight>!'
		);
	});

	// Same phonemes as the pipeline's clips (kokoro-onnx, en-gb), from espeak-ng in WASM.
	it.each([
		['They play Paradiso tomorrow night.', 'ðeɪ plˈeɪ pˌaɹədˈiːzəʊ təmˈɒɹəʊ nˈaɪt.'],
		['Tickets are about 24 euros.', 'tˈɪkɪts ɑːɹ ɐbˌaʊt twˈɛnti fˈɔː jˈʊəɹəʊz.'],
		['Catch them at Tolhuistuin tonight!', 'kˈatʃ ðˌɛm at tˈɒlhaʊstˌaʊn tənˈaɪt!']
	])('%s', async (text, expected) => {
		expect(await toPhonemes(text, LEXICON, phonemize)).toBe(expected);
	});
});

describe('announcerFor (as the pipeline’s announcer_for)', () => {
	it.each([
		['mb:abc', 'bf_isabella'],
		['name:nobu', 'bf_isabella'],
		['mb:5b11f4ce-a62d-471e-81fc-a69a8278c7da', 'bm_fable'],
		['x', 'bm_fable']
	])('%s → %s', async (key, voice) => {
		expect(await announcerFor(key)).toBe(voice);
	});
});

describe('normalise', () => {
	it('brings speech to -18 dBFS RMS and fades the ends', () => {
		const rate = 24000;
		const audio = new Float32Array(rate).map((_, i) => 0.01 * Math.sin(i / 5));
		const out = normalise(audio, rate);
		const rms = Math.sqrt(out.reduce((a, x) => a + x * x, 0) / out.length);
		expect(20 * Math.log10(rms)).toBeCloseTo(-18, 0);
		expect(out[0]).toBe(0);
		expect(out[out.length - 1]).toBe(-0);
	});

	it('leaves silence alone', () => {
		expect(normalise(new Float32Array(10), 24000)).toEqual(new Float32Array(10));
	});
});
