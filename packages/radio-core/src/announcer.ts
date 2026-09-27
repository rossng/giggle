/**
 * Small pieces the presenter (`presenter.ts`) builds its lines from: the voice modes, the
 * venue as said ("Patronaat in Haarlem"), song titles worth saying, the ticket-news phrase
 * banks and the final spacing and punctuation pass.
 */

import type { Template } from "./picker.ts";
import type { QueueEntry } from "./queue.ts";
import { cleanSongTitle } from "./titles.ts";
import type { Gig, Venue } from "./types.ts";

export type VoiceMode = "off" | "name" | "short";

/** The longest song title worth saying out loud. */
export const MAX_SPOKEN_TITLE = 70;

export interface PriceCtx {
  price: string;
  range: boolean;
}

export const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

// ---------- ticket news ----------

export const SOLD_OUT: readonly string[] = [
  "It's sold out, sadly.",
  "That one's already sold out.",
  "Tickets are gone, I'm afraid.",
  "It's sold out, so keep an eye out for resale.",
];
export const FEW_LEFT: readonly string[] = [
  "Only a few tickets left.",
  "Tickets are nearly gone.",
  "It's almost sold out.",
  "Be quick: tickets are running low.",
];
export const FREE: readonly string[] = ["And it's free.", "Entry is free.", "It's free to get in."];
export const NOT_YET: readonly string[] = ["Tickets aren't on sale just yet.", "Tickets aren't on sale yet, so watch this space."];
export const POSTPONED: readonly string[] = ["Heads up: it's been postponed, so check the date.", "Note that it's been postponed."];

export const PRICE: Template<PriceCtx>[] = [
  (c) => `Tickets from ${c.price}.`,
  (c) => `Tickets start at ${c.price}.`,
  (c) => !c.range && `It's ${c.price} to get in.`,
  (c) => !c.range && `Tickets are ${c.price}.`,
];

/**
 * Final spacing and punctuation pass. Names can end in their own punctuation ("mike.",
 * "M.I.K.E.", "Oh Wonder!"), so a template's full stop or comma after one is dropped.
 */
export function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:])/g, "$1")
    .replace(/([.!?])[.,](?=\s|$)/g, "$1")
    .trim();
}

/** "Paradiso", or "Patronaat in Haarlem" outside `homeCity`; the slug for unknown venues. */
export function spokenWhere(gig: Gig, venues: Readonly<Record<string, Venue>>, homeCity: string): string {
  const venue = venues[gig.venue];
  const name = venue?.name?.trim() || cap(gig.venue);
  const city = (gig.city ?? venue?.city ?? "").trim();
  if (!city || city.toLowerCase() === homeCity.toLowerCase() || name.toLowerCase().includes(city.toLowerCase())) {
    return name;
  }
  return `${name} in ${city}`;
}

/** The cleaned title of track `trackIndex`, or null when missing or too long to say. */
export function spokenSong(entry: QueueEntry, trackIndex: number): string | null {
  const title = entry.tracks[trackIndex]?.title;
  const song = title ? cleanSongTitle(title, entry.name) : "";
  return song && song.length <= MAX_SPOKEN_TITLE ? song : null;
}
