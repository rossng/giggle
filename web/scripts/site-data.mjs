#!/usr/bin/env node
// Copies the pipeline's site data into the built app: gigs.json, artists.json,
// pronunciation.json, and only the announcer clips artists.json refers to. The nightly
// build carries every clip it has ever rendered forward (so none is rendered twice), but
// the site needs just the current ones, and Workers static assets cap the file count.
//
//   node web/scripts/site-data.mjs data/site web/build/data

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
	console.error('usage: site-data.mjs <data/site> <web/build/data>');
	process.exit(2);
}

const FILES = ['gigs.json', 'artists.json', 'pronunciation.json'];
mkdirSync(to, { recursive: true });
for (const name of FILES) copyFileSync(join(from, name), join(to, name));

const { artists } = JSON.parse(readFileSync(join(from, 'artists.json'), 'utf8'));
const clips = new Set();
for (const artist of Object.values(artists)) {
	for (const a of artist.announce ?? []) if (a.clip) clips.add(a.clip);
}
let missing = 0;
for (const clip of clips) {
	// "voice/<hash>.mp3": never let a path climb out of the data directory.
	if (!/^voice\/[0-9a-f]+\.mp3$/.test(clip)) throw new Error(`unexpected clip path: ${clip}`);
	const source = join(from, clip);
	if (!existsSync(source)) {
		missing++;
		continue;
	}
	mkdirSync(dirname(join(to, clip)), { recursive: true });
	copyFileSync(source, join(to, clip));
}
console.log(
	`site data: ${FILES.length} files, ${clips.size - missing} clips` +
		(missing ? ` (${missing} missing)` : '')
);
if (missing) process.exit(1);
