import type { QueueEntry } from "../src/queue.ts";
import type { Gig, GigArtist, Track, Venue } from "../src/types.ts";
import sample from "./fixtures/gigs.sample.json" with { type: "json" };

/** Saturday 26 September 2026, noon in Amsterdam (the sample data's build day). */
export const NOW = new Date("2026-09-26T12:00:00+02:00");

/** A real gigs.json, cut down: `venues` and `gigs` (more fields than radio-core reads). */
export const SAMPLE = sample as unknown as { venues: Record<string, Venue>; gigs: Gig[] };

let counter = 0;

export function gig(overrides: Partial<Gig> & { artists?: readonly GigArtist[] } = {}): Gig {
  counter++;
  const artists = overrides.artists ?? [{ key: `name:artist${counter}`, name: `Artist ${counter}`, role: "headliner" }];
  return {
    id: `paradiso:${counter}`,
    venue: "paradiso",
    start: "2026-09-27T20:30:00+02:00",
    city: "Amsterdam",
    status: "scheduled",
    availability: "on_sale",
    price: { min_eur: 20, max_eur: 20 },
    ...overrides,
    artists,
  };
}

export function track(id: string, title = `Song ${id}`): Track {
  return { videoId: id, title };
}

/** A queue entry for `key`, playing at `start` (2 tracks by default). */
export function entry(key: string, start = "2026-09-27T20:30:00+02:00", extra: Partial<QueueEntry> = {}): QueueEntry {
  const name = extra.name ?? key.replace(/^name:/, "");
  const g = gig({ id: `gig:${key}`, start, artists: [{ key, name, role: extra.role ?? "headliner" }] });
  return {
    artistKey: key,
    name,
    role: "headliner",
    gig: g,
    tracks: [track(`${key}-1`), track(`${key}-2`)],
    ...extra,
  };
}

export function keys(entries: readonly QueueEntry[]): string[] {
  return entries.map((e) => e.artistKey);
}

/** Days after NOW as an ISO string with the Amsterdam summer offset. */
export function inDays(days: number, time = "20:00"): string {
  const d = new Date(Date.UTC(2026, 8, 26 + days));
  const iso = d.toISOString().slice(0, 10);
  return `${iso}T${time}:00+02:00`;
}
