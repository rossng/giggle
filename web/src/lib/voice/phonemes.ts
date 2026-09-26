// Text → Kokoro phonemes in the browser, matching the pipeline's clips: the lexicon's
// names go in as their IPA, everything else goes through espeak-ng (British "en") the way
// kokoro-js does it. The normalisation and phoneme fixes are ported from kokoro-js 1.2.1's
// phonemize(), which it doesn't export; `phonemize` is injected so tests needn't load espeak.

import type { Lexicon } from './lexicon';

/** espeak-ng: text → phonemes, one string per clause. */
export type Phonemize = (text: string, language: string) => Promise<string[]>;

function splitNum(num: string): string {
	if (num.includes('.')) return num;
	if (num.includes(':')) {
		const [h, m] = num.split(':').map(Number);
		if (m === 0) return `${h} o'clock`;
		return m! < 10 ? `${h} oh ${m}` : `${h} ${m}`;
	}
	const year = parseInt(num.slice(0, 4), 10);
	if (year < 1100 || year % 1000 < 10) return num;
	const left = num.slice(0, 2);
	const right = parseInt(num.slice(2, 4), 10);
	const s = num.endsWith('s') ? 's' : '';
	if (year % 1000 >= 100 && year % 1000 <= 999) {
		if (right === 0) return `${left} hundred${s}`;
		if (right < 10) return `${left} oh ${right}${s}`;
	}
	return `${left} ${right}${s}`;
}

function flipMoney(m: string): string {
	const bill = m[0] === '$' ? 'dollar' : 'pound';
	if (isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${bill}s`;
	if (!m.includes('.')) return `${m.slice(1)} ${bill}${m.slice(1) === '1' ? '' : 's'}`;
	const [b, c] = m.slice(1).split('.');
	const d = parseInt(c!.padEnd(2, '0'), 10);
	const coins = m[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence';
	return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}

function pointNum(num: string): string {
	const [a, b] = num.split('.');
	return `${a} point ${b!.split('').join(' ')}`;
}

/** kokoro-js's text normalisation (numbers, times, money, abbreviations). */
export function normalise(text: string): string {
	return text
		.replace(/[‘’]/g, "'")
		.replace(/«/g, '“')
		.replace(/»/g, '”')
		.replace(/[“”]/g, '"')
		.replace(/\(/g, '«')
		.replace(/\)/g, '»')
		.replace(/[^\S \n]/g, ' ')
		.replace(/ {2,}/g, ' ')
		.replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
		.replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
		.replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
		.replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
		.replace(/\betc\.(?! [A-Z])/gi, 'etc')
		.replace(/\b(y)eah?\b/gi, "$1e'a")
		.replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
		.replace(/(?<=\d),(?=\d)/g, '')
		.replace(
			/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
			flipMoney
		)
		.replace(/\d*\.\d+/g, pointNum)
		.replace(/(?<=\d)-(?=\d)/g, ' to ')
		.replace(/(?<=\d)S/g, ' S')
		.replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
		.replace(/(?<=X')S\b/g, 's')
		.replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
		.replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-');
}

const PUNCTUATION = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;

/** Plain text → phonemes, keeping punctuation (Kokoro uses it for pauses). */
async function plain(text: string, phonemize: Phonemize): Promise<string> {
	const parts: string[] = [];
	let pos = 0;
	for (const m of text.matchAll(PUNCTUATION)) {
		if (m.index > pos) parts.push((await phonemize(text.slice(pos, m.index), 'en')).join(' '));
		parts.push(m[0]);
		pos = m.index + m[0].length;
	}
	if (pos < text.length) parts.push((await phonemize(text.slice(pos), 'en')).join(' '));
	return parts.join('');
}

/** kokoro-js's fixes to espeak's output (British voices). */
function fix(phonemes: string): string {
	return phonemes
		.replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
		.replace(/ʲ/g, 'j')
		.replace(/r/g, 'ɹ')
		.replace(/x/g, 'k')
		.replace(/ɬ/g, 'l')
		.replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
		.replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
		.trim();
}

/** Phonemes for a line, with the lexicon's names spliced in as they are. */
export async function toPhonemes(
	text: string,
	lexicon: Lexicon | null,
	phonemize: Phonemize
): Promise<string> {
	const pieces = lexicon ? lexicon.split(text) : [{ text }];
	let out = '';
	for (const piece of pieces) {
		if (piece.ipa !== undefined) {
			out += piece.ipa;
			continue;
		}
		const lead = /^\s/.test(piece.text) ? ' ' : '';
		const trail = /\s$/.test(piece.text) ? ' ' : '';
		const body = normalise(piece.text).trim();
		out += lead + (body ? await plain(body, phonemize) : '') + trail;
	}
	return fix(out.replace(/\s+/g, ' '));
}
