/**
 * Queue building: one entry per artist, at their earliest upcoming gig, with the
 * first N tracks the app found for them.
 */

import type { Artist, ArtistRole, Gig, Track } from "./types.ts";
import { isoMs } from "./time.ts";

export interface QueueEntry {
  artistKey: string;
  /** Display and spoken name: the artists.json name when given, else the gig's. */
  name: string;
  /** Their role at `gig`. */
  role: ArtistRole;
  /** Their earliest upcoming gig among those passed in. */
  gig: Gig;
  /** At least one track. */
  tracks: Track[];
  artist?: Artist;
}

/** artistKey → tracks, best first. A Map, a plain object or a function all work. */
export type TrackLookup =
  | ReadonlyMap<string, readonly Track[]>
  | Readonly<Record<string, readonly Track[] | undefined>>
  | ((artistKey: string) => readonly Track[] | undefined);

export interface BuildQueueOptions {
  /** Gigs already filtered by the listener's settings (days, cities…). */
  gigs: readonly Gig[];
  tracks: TrackLookup;
  now: Date;
  /** Tracks per artist (default 2). */
  tracksPerArtist?: number;
  /** Artist keys the listener marked "not for me". */
  notForMe?: Iterable<string>;
  /** artists.json records, for canonical names. */
  artists?: Readonly<Record<string, Artist>>;
}

export interface BuiltQueue {
  /** Soonest gig first (the `date` order). */
  entries: QueueEntry[];
  /** Artists left out because no track was found. */
  withoutTracks: string[];
  /** Artists left out because the listener marked them "not for me". */
  notForMe: string[];
}

export const DEFAULT_TRACKS_PER_ARTIST = 2;
/** Without an end time, a gig counts as upcoming until this long after it starts. */
export const GIG_GRACE_MS = 4 * 3_600_000;

/** Whether a gig is still worth playing for: not cancelled and not over yet. */
export function isUpcoming(gig: Gig, now: Date): boolean {
  if (gig.status === "cancelled") return false;
  const start = isoMs(gig.start);
  if (Number.isNaN(start)) return false;
  const end = isoMs(gig.end);
  const over = Number.isNaN(end) || end < start ? start + GIG_GRACE_MS : end;
  return over > now.getTime();
}

function lookupTracks(lookup: TrackLookup, key: string): readonly Track[] {
  if (typeof lookup === "function") return lookup(key) ?? [];
  if (lookup instanceof Map) return lookup.get(key) ?? [];
  const found = (lookup as Readonly<Record<string, readonly Track[] | undefined>>)[key];
  return Object.hasOwn(lookup, key) && Array.isArray(found) ? found : [];
}

/** Up to `n` distinct, playable tracks. */
export function pickTracks(tracks: readonly Track[], n: number): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    if (out.length >= n) break;
    if (!t || typeof t.videoId !== "string" || !t.videoId || seen.has(t.videoId)) continue;
    seen.add(t.videoId);
    out.push(t);
  }
  return out;
}

/** Soonest start first; ties by gig id, then by billing order. */
export function compareByDate(a: QueueEntry, b: QueueEntry): number {
  return (
    isoMs(a.gig.start) - isoMs(b.gig.start) ||
    (a.gig.id < b.gig.id ? -1 : a.gig.id > b.gig.id ? 1 : 0) ||
    billingIndex(a) - billingIndex(b)
  );
}

function billingIndex(e: QueueEntry): number {
  const i = e.gig.artists.findIndex((a) => a.key === e.artistKey);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

export function buildQueue(options: BuildQueueOptions): BuiltQueue {
  const n = Math.max(1, Math.floor(options.tracksPerArtist ?? DEFAULT_TRACKS_PER_ARTIST));
  const nope = new Set(options.notForMe ?? []);
  const gigs = options.gigs
    .filter((g) => isUpcoming(g, options.now))
    .sort((a, b) => isoMs(a.start) - isoMs(b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const entries: QueueEntry[] = [];
  const decided = new Set<string>();
  const withoutTracks: string[] = [];
  const notForMe: string[] = [];
  for (const gig of gigs) {
    for (const ref of gig.artists ?? []) {
      if (!ref?.key || decided.has(ref.key)) continue;
      decided.add(ref.key);
      if (nope.has(ref.key)) {
        notForMe.push(ref.key);
        continue;
      }
      const tracks = pickTracks(lookupTracks(options.tracks, ref.key), n);
      if (!tracks.length) {
        withoutTracks.push(ref.key);
        continue;
      }
      const artist = options.artists?.[ref.key];
      const entry: QueueEntry = {
        artistKey: ref.key,
        name: artist?.name?.trim() || ref.name.trim() || ref.key,
        role: ref.role === "support" ? "support" : "headliner",
        gig,
        tracks,
      };
      if (artist) entry.artist = artist;
      entries.push(entry);
    }
  }
  entries.sort(compareByDate);
  return { entries, withoutTracks, notForMe };
}
