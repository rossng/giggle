// Which announcer introduces an artist: the pipeline's `announcer_for` (voice.py), so the
// live line after a clip is in the clip's voice.

export const ANNOUNCERS = ['bf_isabella', 'bm_fable'] as const;
export type Announcer = (typeof ANNOUNCERS)[number];

/** Stable per artist, roughly half each: the first byte of sha256(artist key). */
export async function announcerFor(artistKey: string): Promise<Announcer> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artistKey));
	return ANNOUNCERS[new Uint8Array(digest)[0]! % ANNOUNCERS.length]!;
}
