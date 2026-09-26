// Coarse genre buckets for filtering and colour.
//
// Venues label genres in their own way ("Alternative / Indie / Rock", "Pop / Rock",
// "Hiphop - Nederlandstalige Hiphop", "Soul/Jazz- r&b/Neo-soul/Trap soul"), in Dutch and
// English, and MusicBrainz and Last.fm add their own tags. Each label maps to zero or more
// buckets by keyword, in the order the keywords appear in it, so the first bucket of a
// gig's first label is its primary colour. The detailed labels stay for display.

import type { Artist, Gig } from './types';

export const GENRE_IDS = [
	'indie',
	'rock',
	'pop',
	'hiphop',
	'soul',
	'jazz',
	'electronic',
	'folk',
	'global',
	'experimental',
	'dutch'
] as const;

export type GenreId = (typeof GENRE_IDS)[number];

export interface GenreInfo {
	id: GenreId;
	/** Short label for chips. */
	label: string;
	/** What the bucket covers. */
	description: string;
	/** Light enough for dark text on it (poster tiles), bright enough to read on #15111C. */
	colour: string;
}

export const GENRES: Record<GenreId, GenreInfo> = {
	indie: {
		id: 'indie',
		label: 'Indie',
		description: 'Indie, alternative, dream pop, shoegaze',
		colour: '#FF9A5E'
	},
	rock: {
		id: 'rock',
		label: 'Rock & punk',
		description: 'Rock, post-punk, punk, metal, grunge',
		colour: '#FF6B80'
	},
	pop: { id: 'pop', label: 'Pop', description: 'Pop, synth-pop, classic pop', colour: '#FF8FCF' },
	hiphop: {
		id: 'hiphop',
		label: 'Hip-hop & R&B',
		description: 'Hip-hop, rap, trap, grime, R&B',
		colour: '#CF95F0'
	},
	soul: {
		id: 'soul',
		label: 'Soul & funk',
		description: 'Soul, funk, disco, gospel',
		colour: '#EBAF84'
	},
	jazz: { id: 'jazz', label: 'Jazz', description: 'Jazz, improvised music', colour: '#E8C659' },
	electronic: {
		id: 'electronic',
		label: 'Electronic',
		description: 'Electronic, synth, techno, house, dance',
		colour: '#8EA3FF'
	},
	folk: {
		id: 'folk',
		label: 'Folk & roots',
		description: 'Folk, Americana, country, blues, singer-songwriter',
		colour: '#7FD1A0'
	},
	global: {
		id: 'global',
		label: 'Global',
		description: 'Latin, Afro, reggae, Middle Eastern, Balkan and more',
		colour: '#5CCFD9'
	},
	experimental: {
		id: 'experimental',
		label: 'Experimental',
		description: 'Experimental, avant-garde, noise, ambient, neo-classical',
		colour: '#B9BED0'
	},
	dutch: {
		id: 'dutch',
		label: 'Nederlandstalig',
		description: 'Dutch-language pop, hip-hop and kleinkunst',
		colour: '#C6E274'
	}
};

/** Colour for gigs no bucket fits. */
export const NO_GENRE_COLOUR = '#9A91AE';

export function isGenreId(value: string): value is GenreId {
	return (GENRE_IDS as readonly string[]).includes(value);
}

// Order matters only for ties at the same position in a label.
const RULES: [RegExp, GenreId][] = [
	[/\bnederlands\b|nederlandstalig|nederpop|nederhop|kleinkunst|levenslied|smartlap/, 'dutch'],
	[
		/hip ?-?hop|\brap\b|rapper|\btrap\b|\bdrill\b|grime|\br ?& ?b\b|\brnb\b|nederhop|\brage\b|boom ?bap/,
		'hiphop'
	],
	[
		/indie|alternati(?:ve|ef|eve)(?! ?(?:r ?& ?b|rnb|hip ?-?hop))|\balt\b(?! ?-?(?:r ?& ?b|rnb|country))|altpop|shoegaze|dream ?pop|dromerig|bedroom ?pop|\blo-?fi\b|slacker|britpop|art ?pop|art ?rock|chamber pop|jangle/,
		'indie'
	],
	[
		/rock|punk|metal|heavy|\bloud\b|grunge|\bwave\b|hardcore|\bemo\b|stoner|(?<!uk )garage|doom|sludge|thrash|psychedel/,
		'rock'
	],
	[/pop(?! ?-?punk)|\bhits\b|eurovisie|\b[5-9]0'?s\b|zeroes|tiktok/, 'pop'],
	[/soul|funk|(?<!italo ?)disco|groove|gospel|motown/, 'soul'],
	[/jazz|\bimpro|bebop|\bswing\b|big ?band|\becm\b|\bfusion\b|saxofon/, 'jazz'],
	[
		/electr|elektr|techno|house|trance|drum ?(?:&|and|n) ?bass|\bdnb\b|jungle|dubstep|\buk bass\b|uk garage|\bedm\b|\brave\b|(?<!line ?)dance(?!hall)|synth|hyperpop|trip ?-?hop|downtempo|\bnrg\b|italo ?disco|\bchill/,
		'electronic'
	],
	[
		/folk|americana|country|bluegrass|blues|roots|singer ?-?songwriter|akoestisch|acoustic|line ?dance/,
		'folk'
	],
	[
		/global|\bworld|wereld|afro|latin|latijn|reggae|dancehall|\bska\b|\bdub\b|cumbia|samba|bossa|forro|\bmpb\b|brega|dembow|baile|salsa|balkan|klezmer|\broma\b|gypsy|\bturks|turkish|koerdisch|kurdish|arab|midden.oosten|middle east|noord.afrika|caribbean|braziliaans|brazilian|flamenco|fado|tango|chanson|\bfrans|italiaans|koreaans|jamaica|amapiano|highlife/,
		'global'
	],
	[
		/experiment|avant|hedendaags|\bimpro|noise|drone|ambient|multidisciplin|genre-?bending|eigenzinnig|minimalist|neoklassiek|neo-?classical|modern classical|cinematisch|cinematic|filmmuziek|soundtrack|krautrock|no wave/,
		'experimental'
	]
];

function normalise(label: string): string {
	return label
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[‘’`]/g, "'")
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/** Buckets for one label, in the order their keywords appear in it. */
export function bucketsForLabel(label: string): GenreId[] {
	const text = normalise(label);
	const hits: { at: number; order: number; id: GenreId }[] = [];
	RULES.forEach(([pattern, id], order) => {
		const match = pattern.exec(text);
		if (match) hits.push({ at: match.index, order, id });
	});
	hits.sort((a, b) => a.at - b.at || a.order - b.order);
	return unique(hits.map((h) => h.id));
}

/** Buckets for several labels: each label's buckets in turn, without repeats. */
export function bucketsFor(labels: Iterable<string>): GenreId[] {
	const out: GenreId[] = [];
	for (const label of labels) out.push(...bucketsForLabel(label));
	return unique(out);
}

/** The labels that say what a gig sounds like: the venue's genres first (or, without any,
 * its categories, which are often a department such as TivoliVredenburg's "Pop"), then its
 * headliners' MusicBrainz genres and tags and Last.fm tags. */
export function gigLabels(gig: Gig, artists: Record<string, Artist>): string[] {
	const labels = gig.genres.length ? [...gig.genres] : [...gig.categories];
	for (const ref of gig.artists) {
		if (ref.role !== 'headliner') continue;
		const artist = artists[ref.key];
		if (!artist) continue;
		labels.push(...(artist.musicbrainz?.genres ?? []));
		labels.push(...(artist.musicbrainz?.tags ?? []));
		labels.push(...(artist.lastfm?.tags ?? []));
	}
	return labels;
}

export function gigBuckets(gig: Gig, artists: Record<string, Artist>): GenreId[] {
	return bucketsFor(gigLabels(gig, artists));
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}
