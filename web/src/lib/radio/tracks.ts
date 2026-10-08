// What the radio can play for each artist: the songs on their YouTube Music page, as
// radio-core Tracks (source-agnostic `{videoId, title, album}`), best first.

import type { IntroClip, Track } from '@giggle/radio-core';
import { imageSrc } from '$lib/data/image-hosts';
import type { Artist, YoutubeArtist, YoutubeSong } from '$lib/data/types';

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** Playable tracks from YouTube Music songs: valid ids only, no repeats, in order. */
export function songsToTracks(songs: readonly YoutubeSong[] | null | undefined): Track[] {
	const seen = new Set<string>();
	const out: Track[] = [];
	for (const song of songs ?? []) {
		const id = song?.videoId;
		if (typeof id !== 'string' || !VIDEO_ID.test(id) || seen.has(id)) continue;
		seen.add(id);
		const title =
			typeof song.title === 'string' && song.title.trim() ? song.title.trim() : 'Untitled';
		const track: Track = { videoId: id, title };
		if (typeof song.album === 'string' && song.album.trim()) track.album = song.album.trim();
		out.push(track);
	}
	return out;
}

/** artistKey → tracks, for every artist with at least one. */
export function trackIndex(artists: Readonly<Record<string, Artist>>): Map<string, Track[]> {
	const index = new Map<string, Track[]>();
	for (const [key, artist] of Object.entries(artists)) {
		const tracks = songsToTracks(artist.youtube?.songs);
		if (tracks.length) index.set(key, tracks);
	}
	return index;
}

/** A square version of a YouTube Music image (they come as wide banners), for artwork. */
export function squareImage(url: string | null | undefined, size = 544): string | null {
	if (!url) return null;
	return /=w\d+-h\d+/.test(url) ? url.replace(/=w\d+-h\d+/, `=w${size}-h${size}`) : url;
}

/** A track's video thumbnail (YouTube's 480×360 one, which every video has; a 16:9 video
 * fills its middle 480×270, so `object-fit: cover` in a 16:9 box shows no bars). */
export function videoThumbnail(videoId: string): string | undefined {
	if (!VIDEO_ID.test(videoId)) return undefined;
	return imageSrc(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
}

/** The best picture of an artist: YouTube Music, else their Wikipedia thumbnail. */
export function artistImage(artist: Artist | undefined): string | null {
	return imageSrc(artist?.youtube?.image) ?? imageSrc(artist?.wikipedia?.thumbnail) ?? null;
}

export function youtubeMusicUrl(youtube: YoutubeArtist | null | undefined): string | null {
	return youtube?.browseId
		? `https://music.youtube.com/channel/${encodeURIComponent(youtube.browseId)}`
		: null;
}

/** Each artist's pre-rendered intro clips, with URLs under the site's data directory. */
export function introClips(
	artists: Readonly<Record<string, Pick<Artist, 'announce'>>>,
	base = '/data'
): Record<string, IntroClip[]> {
	const clips: Record<string, IntroClip[]> = {};
	for (const [key, artist] of Object.entries(artists)) {
		const list = (artist.announce ?? [])
			.filter((c) => c.clip && c.seconds > 0)
			.map((c) => ({ url: `${base}/${c.clip}`, text: c.text, seconds: c.seconds }));
		if (list.length) clips[key] = list;
	}
	return clips;
}

/** The voice for artists the pipeline hasn't given one. */
export const DEFAULT_ANNOUNCER = 'bf_isabella';

/**
 * The artist's announcer voice (the one their clips use), so live lines match: the pipeline's
 * `announcer`. Data from before that field existed: the voice of their first clip, else the
 * default. (That fallback can go once every artists.json in use has `announcer`.)
 */
export function announcerOf(artist: Pick<Artist, 'announcer' | 'announce'> | undefined): string {
	return artist?.announcer ?? artist?.announce?.[0]?.voice ?? DEFAULT_ANNOUNCER;
}
