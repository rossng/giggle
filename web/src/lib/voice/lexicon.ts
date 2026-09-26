// The announcers' pronunciation lexicon (pipeline/src/giggle_pipeline/pronunciation.toml,
// published as /data/pronunciation.json), so live lines say names the way the pre-rendered
// clips do. A port of `Lexicon` in the pipeline's voice.py: whole words, longest written
// form first, case-insensitive unless `match_case`, possessive 's with the right ending.

export interface LexiconEntry {
	written: string;
	/** IPA in espeak-ng's en-gb symbols. */
	ipa: string;
	match_case: boolean;
}

/** A stretch of text: plain (for the phonemizer), or a name with its phonemes. */
export type Piece = { text: string; ipa?: undefined } | { text: string; ipa: string };

const VOICELESS = new Set('ptkfθ');
const SIBILANTS = new Set('szʃʒ');

export function possessive(ipa: string): string {
	const last = ipa.replace(/[ˈˌː ]+$/u, '').slice(-1);
	if (SIBILANTS.has(last)) return ipa + 'ɪz';
	return ipa + (VOICELESS.has(last) ? 's' : 'z');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Lexicon {
	readonly entries: readonly LexiconEntry[];
	readonly #pattern: RegExp;

	constructor(entries: readonly LexiconEntry[]) {
		this.entries = entries;
		// Longest first, so a multi-word name wins over the words inside it. Matching is
		// case-insensitive throughout; match_case entries are checked after matching.
		const ordered = entries.map((e, i) => [i, e] as const);
		ordered.sort((a, b) => b[1].written.length - a[1].written.length);
		const alternatives = ordered.map(
			([i, e]) => `(?<e${i}>${e.written.split(/\s+/).map(escape).join('\\s+')})`
		);
		const body = alternatives.join('|') || '(?!)';
		this.#pattern = new RegExp(
			`(?<![\\p{L}\\p{N}_])(?:${body})(?<poss>'s)?(?![\\p{L}\\p{N}_])`,
			'giu'
		);
	}

	static parse(data: unknown): Lexicon {
		const names = (data as { names?: unknown } | null)?.names;
		if (!Array.isArray(names)) return new Lexicon([]);
		return new Lexicon(
			names.filter(
				(n): n is LexiconEntry =>
					typeof n?.written === 'string' && typeof n?.ipa === 'string' && !!n.written
			)
		);
	}

	/** The text split into plain stretches and known names with their phonemes. */
	split(text: string): Piece[] {
		text = text.replace(/’/g, "'");
		const pieces: Piece[] = [];
		let pos = 0;
		for (const m of text.matchAll(this.#pattern)) {
			const i = Number(
				Object.entries(m.groups ?? {})
					.find(([k, v]) => k !== 'poss' && v !== undefined)?.[0]
					?.slice(1)
			);
			const entry = this.entries[i];
			const name = m[0].slice(0, m[0].length - (m.groups?.poss?.length ?? 0));
			if (!entry || (entry.match_case && name.replace(/\s+/g, ' ') !== entry.written)) continue;
			if (m.index > pos) pieces.push({ text: text.slice(pos, m.index) });
			const ipa = m.groups?.poss ? possessive(entry.ipa) : entry.ipa;
			pieces.push({ text: m[0], ipa });
			pos = m.index + m[0].length;
		}
		if (pos < text.length) pieces.push({ text: text.slice(pos) });
		return pieces;
	}
}
