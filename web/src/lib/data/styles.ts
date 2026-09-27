// Specific styles ("post-punk", "shoegaze", "hard bop") under the coarse genre buckets.
//
// A gig's styles come from the same labels as its buckets (genres.ts `gigLabels`): the venue's
// genre labels and its headliners' MusicBrainz genres and tags and Last.fm tags. Each label is
// split into parts ("Soul/Jazz - Classic Soul, Funk" → soul, jazz, classic soul, funk), and each
// part normalised:
//
//   - lowercased, accents and parentheticals dropped ("Classic Pop (60's-90's)" → classic pop);
//   - a few Dutch venue words translated (elektronisch → electronic, neoklassiek → neo-classical)
//     and synonyms merged (heavy → metal, nederlandstalige hiphop → nederhop);
//   - spelling variants merged by a *key* that ignores spaces, hyphens and "&"/"and"/"n"
//     ("post punk", "Postpunk", "post-punk" → postpunk; "r&b", "rnb" → rnb), shown with the
//     most common spelling;
//   - dropped when it's no style at all: anything no bucket's keywords recognise ("seen live",
//     "female vocalists", "british", "piano"), decades and years, long phrases, and a few
//     words that do hit a bucket but only as a venue's programme name ("loud", "hits").
//
// Parts that are just a bucket's own name ("indie", "rock", "jazz"…) are kept on the gig (the
// row shows them) but aren't offered as styles: picking "jazz" inside Jazz narrows nothing.
// A style belongs to every bucket its name's keywords hit ("indie folk" → Indie and Folk).
//
// In the URL a style is a slug of its name (`style=post-punk,rnb`), matched by key, so
// `postpunk` or a later change of spelling still finds the same gigs.

import { bucketsForLabel, type GenreId } from './genres';

/** A style must be on at least this many gigs to be offered. */
export const MIN_STYLE_GIGS = 3;

export interface StyleName {
	/** Spelling-free identity: lowercase letters and digits only ("postpunk", "rnb"). */
	key: string;
	/** Lowercase display name ("post-punk", "r&b"). */
	name: string;
}

export interface Style extends StyleName {
	/** URL form ("post-punk", "rnb", "drum-n-bass"). */
	slug: string;
	/** Buckets the style belongs to (at least one). */
	buckets: GenreId[];
	/** Gigs with the style, in the whole catalogue. */
	n: number;
}

/** Words that name a whole bucket: kept for display, not offered as styles. */
const GENERIC = new Set(
	[
		'indie',
		'alternative',
		'rock',
		'pop',
		'jazz',
		'electronic',
		'folk',
		'roots',
		'global',
		'world',
		'experimental',
		'nederlandstalig'
	].map(styleKey)
);

/** Parts that hit a bucket's keywords but aren't a style. */
const JUNK = new Set(
	[
		'loud',
		'hits',
		'live',
		'seen live',
		'headliners',
		'rock the city',
		'pop music',
		'rock music',
		'jazz music',
		'jazzy',
		'jamaica',
		'multidisciplinair',
		'the rest is noise'
	].map(styleKey)
);

/** Words that make a part a description rather than a style ("female fronted metal",
 * "nederlandse indie acts", "ecm recordings artists"). */
const JUNK_WORDS =
	/\b(?:acts?|artists?|vocalists?|fronted|recordings|sensatie|bands?|music from|scene|favou?rites?)\b/;

/** "rock and indie", "soul en funk", "latin & caribbean" are two styles; these are one. */
const ONE_STYLE = new Set(['drumnbass', 'rocknroll', 'rhythmnblues', 'rnb', 'randb']);

/** Whole-part rewrites, after cleaning: Dutch venue words and synonyms. */
const ALIASES: Record<string, string> = {
	elektronisch: 'electronic',
	electronisch: 'electronic',
	'electronisch live': 'electronic',
	'elektronisch live': 'electronic',
	elektronica: 'electronica',
	elektro: 'electro',
	neoklassiek: 'neo-classical',
	'neo classical': 'neo-classical',
	alternatief: 'alternative',
	alternatieve: 'alternative',
	'alternatieve pop': 'alt-pop',
	'alternative pop': 'alt-pop',
	'alt pop': 'alt-pop',
	altpop: 'alt-pop',
	wereld: 'world',
	wereldmuziek: 'world',
	'world music': 'world',
	nederlands: 'nederlandstalig',
	nederlandse: 'nederlandstalig',
	'nederlandstalige act': 'nederlandstalig',
	'nederlandstalige pop': 'nederpop',
	'nederlandstalige hiphop': 'nederhop',
	'nederlandstalige rap': 'nederhop',
	'dutch hip hop': 'nederhop',
	'dutch hiphop': 'nederhop',
	'dutch rap': 'nederhop',
	heavy: 'metal',
	'heavy metal': 'heavy metal',
	hiphop: 'hip-hop',
	'hip hop': 'hip-hop',
	rnb: 'r&b',
	'r and b': 'r&b',
	'rhythm and blues': 'r&b',
	'rhythm & blues': 'r&b',
	'singer songwriter': 'singer-songwriter',
	singersongwriter: 'singer-songwriter',
	'latijns-amerikaans': 'latin',
	'latijns amerikaans': 'latin',
	latijn: 'latin',
	'latin american': 'latin',
	turks: 'turkish',
	koerdisch: 'kurdish',
	'midden oosten': 'middle eastern',
	'midden-oosten': 'middle eastern',
	'middle east': 'middle eastern',
	'noord afrika': 'north african',
	'noord-afrika': 'north african',
	braziliaans: 'brazilian',
	'musica popular brasileira': 'mpb',
	hedendaags: 'contemporary',
	klassiek: 'classical',
	eurovisiesongfestival: 'eurovision',
	'eurovisie songfestival': 'eurovision',
	eurovisie: 'eurovision',
	'drum and bass': 'drum & bass',
	'drum n bass': 'drum & bass',
	dnb: 'drum & bass',
	'lo fi': 'lo-fi',
	lofi: 'lo-fi',
	'alt-r&b': 'alternative r&b',
	'alt r&b': 'alternative r&b',
	'impro focus': 'improvised',
	improvisatie: 'improvised',
	'improvised music': 'improvised',
	fusion: 'jazz fusion',
	stoner: 'stoner rock',
	thrash: 'thrash metal',
	garage: 'garage rock',
	'sludge metal': 'sludge',
	chill: 'chillout',
	'chill out': 'chillout',
	'dutch pop': 'nederpop',
	'psychedelische rock': 'psychedelic rock',
	psychedelisch: 'psychedelic',
	akoestisch: 'acoustic',
	'arabische muziek': 'arabic',
	arab: 'arabic',
	cinematisch: 'cinematic',
	experimenteel: 'experimental',
	countrypop: 'country pop',
	conscious: 'conscious hip-hop',
	'eurovision song contest': 'eurovision',
	'country-pop': 'country pop'
};

/** Spellings shown for keys whose variants are common (else the most frequent one wins). */
const SPELLING: Record<string, string> = {
	hiphop: 'hip-hop',
	rnb: 'r&b',
	postpunk: 'post-punk',
	postrock: 'post-rock',
	posthardcore: 'post-hardcore',
	postbop: 'post-bop',
	synthpop: 'synth-pop',
	triphop: 'trip-hop',
	lofi: 'lo-fi',
	neosoul: 'neo-soul',
	singersongwriter: 'singer-songwriter',
	drumnbass: 'drum & bass',
	indiepop: 'indie pop',
	indierock: 'indie rock',
	indiefolk: 'indie folk',
	poprock: 'pop rock',
	newwave: 'new wave',
	dreampop: 'dream pop',
	altcountry: 'alt-country',
	rocknroll: "rock 'n' roll",
	ukhiphop: 'uk hip-hop',
	undergroundhiphop: 'underground hip-hop'
};

/** Spelling-free identity of a style name (or slug): "Post Punk", "post-punk" → "postpunk". */
export function styleKey(text: string): string {
	return clean(text)
		.replace(/\s*(?:&|\band\b|'n'?|\bn\b)\s*/g, 'n')
		.replace(/[^a-z0-9]/g, '');
}

/** URL form of a style name: "post-punk", "rnb", "drum-n-bass", "rock-n-roll". */
export function styleSlug(name: string): string {
	return clean(name)
		.replace(/\b([a-z])\s*&\s*([a-z])\b/g, '$1n$2')
		.replace(/\s*(?:&|'n'?)\s*/g, ' n ')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function clean(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[‘’`´]/g, "'")
		.toLowerCase()
		.replace(/\([^)]*\)?/g, ' ')
		.replace(/_/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Splits a venue's compound label: "Soul/Jazz- r&b/Neo-soul" → soul, jazz, r&b, neo-soul. */
export function splitLabel(label: string): string[] {
	return clean(label)
		.split(/\s*[/|,;+•·]\s*|\s+-\s*|\s*-\s+|\s*:\s+/)
		.flatMap(splitPair)
		.map((part) => part.replace(/^[^a-z0-9&]+|[^a-z0-9&']+$/g, '').trim())
		.filter(Boolean);
}

/** "rock and indie" → rock, indie; but "drum & bass" and "r&b" stay whole. */
function splitPair(part: string): string[] {
	const pair = /^(.{3,}?) (?:and|en|&) (.{3,})$/.exec(part);
	if (!pair || ONE_STYLE.has(styleKey(part))) return [part];
	return [pair[1], pair[2]];
}

/** Spellings that vary inside longer names: "uk hiphop" → "uk hip-hop", "alt rnb" → "alt r&b". */
function respell(text: string): string {
	return text
		.replace(/\bhip ?-?hop\b/g, 'hip-hop')
		.replace(/\br ?n ?b\b|\br ?& ?b\b/g, 'r&b')
		.replace(/\b(post|neo|nu|proto|avant) (?=[a-z])/g, '$1-');
}

const DECADE = /^(?:19|20)?\d0'?s$|^\d{4}$/;

/** One cleaned part as a style name, or null when it's no style. */
export function partStyle(part: string): StyleName | null {
	const respelt = respell(part);
	const text = respell(ALIASES[part] ?? ALIASES[respelt] ?? respelt);
	if (DECADE.test(text) || /\d{3}/.test(text) || JUNK_WORDS.test(text)) return null;
	if (text.length > 32 || text.split(' ').length > 4) return null;
	const key = styleKey(text);
	if (!key || JUNK.has(key)) return null;
	if (!bucketsForLabel(text).length) return null;
	return { key, name: SPELLING[key] ?? text };
}

/** Style names in one label, in order, without repeats. */
export function labelStyles(label: string): StyleName[] {
	const out: StyleName[] = [];
	for (const part of splitLabel(label)) {
		const style = partStyle(part);
		if (style && !out.some((s) => s.key === style.key)) out.push(style);
	}
	return out;
}

/** Style names in several labels, in order, without repeats. */
export function stylesFor(labels: Iterable<string>): StyleName[] {
	const out: StyleName[] = [];
	for (const label of labels) {
		for (const style of labelStyles(label)) {
			if (!out.some((s) => s.key === style.key)) out.push(style);
		}
	}
	return out;
}

/**
 * The buckets a style belongs to, from its name or its slug: every bucket its keywords hit
 * ("indie folk" → indie, folk; "drum-n-bass" → electronic).
 */
export function bucketsForStyle(nameOrSlug: string): GenreId[] {
	const text = clean(nameOrSlug);
	return [...new Set([...bucketsForLabel(text), ...bucketsForLabel(text.replace(/-/g, ' '))])];
}

/** Is this key a bucket's own name (kept for display, not offered as a style)? */
export function isGeneric(key: string): boolean {
	return GENERIC.has(key);
}

/**
 * The styles to offer: each gig's style names, counted once per gig, merged by key, generic ones
 * left out, and only those on at least `min` gigs. Most gigs first, then by name.
 */
export function styleList(
	gigStyles: Iterable<readonly StyleName[]>,
	min = MIN_STYLE_GIGS
): Style[] {
	const byKey = new Map<string, { n: number; spellings: Map<string, number> }>();
	for (const styles of gigStyles) {
		const seen = new Set<string>();
		for (const { key, name } of styles) {
			if (GENERIC.has(key)) continue;
			let entry = byKey.get(key);
			if (!entry) byKey.set(key, (entry = { n: 0, spellings: new Map() }));
			entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
			if (!seen.has(key)) {
				seen.add(key);
				entry.n++;
			}
		}
	}
	const out: Style[] = [];
	for (const [key, { n, spellings }] of byKey) {
		if (n < min) continue;
		const name = SPELLING[key] ?? commonest(spellings);
		const buckets = bucketsForStyle(name);
		if (!buckets.length) continue;
		out.push({ key, name, slug: styleSlug(name), buckets, n });
	}
	return out.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** The most used spelling; ties go to one with a separator ("post-punk" over "postpunk"). */
function commonest(spellings: Map<string, number>): string {
	return [...spellings].sort(
		([a, m], [b, n]) =>
			n - m || Number(/[ -]/.test(b)) - Number(/[ -]/.test(a)) || a.localeCompare(b)
	)[0][0];
}
