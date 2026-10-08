import { describe, expect, it } from 'vitest';
import { IMAGE_SOURCES, imageSrc } from './image-hosts';

describe('imageSrc', () => {
	it('passes https pictures from the listed hosts', () => {
		for (const url of [
			'https://yt3.googleusercontent.com/abc=w544-h544-p-l90-rj',
			'https://lh3.googleusercontent.com/abc',
			'https://yt3.ggpht.com/abc',
			'https://upload.wikimedia.org/wikipedia/commons/5/54/X.jpg',
			'https://i.ytimg.com/vi/DGlKqwJuHps/hqdefault.jpg',
			'https://assets.paradiso.nl/a.jpg?w=400',
			'https://a.storyblok.com/f/287632/950x713/4224334426/new-show-confirmed-2027.jpg',
			'https://ekko.nl/wp-content/uploads/2026/09/moodboard-683x1024.png',
			'https://denieuweanita.nl/wp-content/uploads/2026/09/poster-819x1024.jpg',
			'https://stadsherstel.nl/wp-content/uploads/2026/03/Agenda_janneschra-400x300.jpg'
		]) {
			expect(imageSrc(url)).toBe(url);
		}
	});

	it('drops pictures from anywhere else, and anything but https', () => {
		for (const url of [
			'https://tracker.example/pixel.gif',
			'https://googleusercontent.com/abc', // `*.` is subdomains only, as in CSP
			'https://evilgoogleusercontent.com/abc',
			'https://assets.paradiso.nl.evil.example/a.jpg',
			'https://user:pw@assets.paradiso.nl/a.jpg',
			'http://assets.paradiso.nl/a.jpg',
			'javascript:alert(1)',
			'data:image/png;base64,AAAA',
			'not a url',
			'',
			null,
			undefined
		]) {
			expect(imageSrc(url)).toBeUndefined();
		}
	});

	it('gives the CSP one https source per host', () => {
		expect(IMAGE_SOURCES).toContain('https://*.googleusercontent.com');
		expect(IMAGE_SOURCES.every((s) => /^https:\/\/(\*\.)?[a-z0-9.-]+$/.test(s))).toBe(true);
	});
});
