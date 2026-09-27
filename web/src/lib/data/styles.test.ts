import { describe, expect, it } from 'vitest';
import {
	bucketsForStyle,
	isGeneric,
	labelStyles,
	partStyle,
	splitLabel,
	styleKey,
	styleList,
	styleSlug,
	stylesFor,
	type StyleName
} from './styles';

const names = (label: string) => labelStyles(label).map((s) => s.name);

describe('splitLabel', () => {
	it.each([
		['Pop / Rock', ['pop', 'rock']],
		['Soul/Jazz- r&b/Neo-soul/Trap soul', ['soul', 'jazz', 'r&b', 'neo-soul', 'trap soul']],
		[
			'Americana - Folk/Indie Folk/ Contemporary/Singer-Songwriter',
			['americana', 'folk', 'indie folk', 'contemporary', 'singer-songwriter']
		],
		["Classic Pop (60's-90's)", ['classic pop']],
		['Hiphop - Nederlandstalige Hiphop', ['hiphop', 'nederlandstalige hiphop']],
		['rock and indie', ['rock', 'indie']],
		['Latin & Caribbean', ['latin', 'caribbean']],
		['drum & bass', ['drum & bass']],
		['Rock and Roll', ['rock and roll']],
		['R&B', ['r&b']]
	])('%s', (label, parts) => {
		expect(splitLabel(label)).toEqual(parts);
	});
});

describe('styleKey', () => {
	it('merges spellings', () => {
		const keys = (...xs: string[]) => new Set(xs.map(styleKey));
		expect(keys('post punk', 'Post-Punk', 'postpunk', 'POST PUNK')).toEqual(new Set(['postpunk']));
		expect(keys('r&b', 'rnb', 'R & B', 'r and b')).toEqual(new Set(['rnb']));
		expect(keys('drum & bass', 'drum and bass', "drum 'n' bass", 'drum-n-bass')).toEqual(
			new Set(['drumnbass'])
		);
		expect(keys('Música Popular', 'musica popular')).toEqual(new Set(['musicapopular']));
	});
});

describe('styleSlug', () => {
	it('gives readable URL forms that key back to the style', () => {
		for (const [name, slug] of [
			['post-punk', 'post-punk'],
			['r&b', 'rnb'],
			['drum & bass', 'drum-n-bass'],
			["rock 'n' roll", 'rock-n-roll'],
			['alternative r&b', 'alternative-rnb'],
			['uk hip-hop', 'uk-hip-hop']
		]) {
			expect(styleSlug(name)).toBe(slug);
			expect(styleKey(slug)).toBe(styleKey(name));
		}
	});
});

describe('partStyle / labelStyles', () => {
	it('normalises spellings and Dutch venue words', () => {
		expect(names('Postpunk')).toEqual(['post-punk']);
		expect(names('Hiphop / r&b')).toEqual(['hip-hop', 'r&b']);
		expect(names('Elektronisch')).toEqual(['electronic']);
		expect(names('Neoklassiek')).toEqual(['neo-classical']);
		expect(names('Hiphop - Nederlandstalige Hiphop')).toEqual(['hip-hop', 'nederhop']);
		expect(names('Metal/Punk/Heavy')).toEqual(['metal', 'punk']);
		expect(names('UK Hiphop')).toEqual(['uk hip-hop']);
		expect(names('Alt-RnB')).toEqual(['alternative r&b']);
		expect(names('nu jazz')).toEqual(['nu-jazz']);
	});

	it('drops what is no style', () => {
		for (const junk of [
			'seen live',
			'female vocalists',
			'british',
			'Dutch',
			'piano',
			'80s',
			'2019',
			'LOUD',
			'Live after Lowlands',
			'female fronted metal',
			'nederlandse indie acts',
			'a very long description of a band that plays rock'
		]) {
			expect(partStyle(splitLabel(junk)[0] ?? '')).toBeNull();
		}
	});

	it('keeps nationalities that name a style of global music', () => {
		expect(names('turkish')).toEqual(['turkish']);
		expect(names('Midden Oosten/Noord Afrika')).toEqual(['middle eastern', 'north african']);
	});

	it('takes words that name Object.prototype properties as plain text', () => {
		// A MusicBrainz tag or a venue's genre can be any word.
		for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(partStyle(word)).toBeNull();
			expect(stylesFor([word, 'Postpunk']).map((s) => s.name)).toEqual(['post-punk']);
		}
	});

	it('gathers several labels without repeats', () => {
		expect(stylesFor(['Post Punk', 'post-punk', 'Shoegaze']).map((s) => s.key)).toEqual([
			'postpunk',
			'shoegaze'
		]);
	});
});

describe('bucketsForStyle', () => {
	it('works from a name or a slug alike', () => {
		for (const [name, buckets] of [
			['indie folk', ['indie', 'folk']],
			['drum & bass', ['electronic']],
			['lo-fi', ['indie']],
			['post-punk', ['rock']],
			['r&b', ['hiphop']],
			['hard bop', ['jazz']],
			['afrobeat', ['global']]
		] as const) {
			expect(bucketsForStyle(name)).toEqual(buckets);
			expect(bucketsForStyle(styleSlug(name))).toEqual(buckets);
		}
	});
});

describe('styleList', () => {
	const s = (name: string): StyleName => ({ key: styleKey(name), name });

	it('counts gigs per style, keeps those on enough gigs, most first', () => {
		const list = styleList([
			[s('post-punk'), s('shoegaze'), s('indie')],
			[s('postpunk'), s('shoegaze')],
			[s('post-punk'), s('post punk')],
			[s('indie'), s('indie'), s('shoegaze')],
			[s('indie')]
		]);
		expect(list).toEqual([
			{ key: 'postpunk', name: 'post-punk', slug: 'post-punk', buckets: ['rock'], n: 3 },
			{ key: 'shoegaze', name: 'shoegaze', slug: 'shoegaze', buckets: ['indie'], n: 3 }
		]);
		expect(isGeneric('indie')).toBe(true);
	});

	it('names a style by its commonest spelling', () => {
		const list = styleList(
			[[s('Space Rock')], [s('space-rock')], [s('space-rock')], [s('spacerock')]],
			1
		);
		expect(list.map((x) => x.name)).toEqual(['space-rock']);
	});
});
