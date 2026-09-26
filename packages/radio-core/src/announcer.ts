/**
 * What the presenter says. British English, whole-euro prices, spoken dates.
 *
 * - `artistIntro`: when a new artist comes on. Mode `name` is just who, where and
 *   when; mode `short` adds an intro, sometimes the song, the start time and a
 *   ticket note.
 * - `micro`: now and then, before the 2nd/3rd track by the same artist.
 * - `forTrack`: decides which (if any) of the two a track gets.
 *
 * All randomness comes from the injected `rng`, so output is deterministic.
 */

import type { QueueEntry } from "./queue.ts";
import type { Rng } from "./random.ts";
import { PhrasePicker, type Template } from "./picker.ts";
import { ordinalWord, spokenDay, spokenPrice, spokenTime, type SpokenDay } from "./spoken.ts";
import { DEFAULT_TIME_ZONE, zonedParts } from "./time.ts";
import { cleanSongTitle } from "./titles.ts";
import type { Gig, Venue } from "./types.ts";

export type VoiceMode = "off" | "name" | "short";

export interface AnnouncerProbabilities {
  /** A micro-announcement before a same-artist track (default 0.6). */
  micro: number;
  /** Saying the price when nothing more urgent (sold out…) is said (default 0.65). */
  price: number;
  /** Adding the start time to a gig line (default 0.5). */
  time: number;
  /** Leading with the gig instead of the name (default 0.2). */
  leadWithGig: number;
}

export const DEFAULT_PROBABILITIES: AnnouncerProbabilities = {
  micro: 0.6,
  price: 0.65,
  time: 0.5,
  leadWithGig: 0.2,
};

export interface AnnouncerOptions {
  rng: Rng;
  /** gigs.json `venues`, for venue names (the slug is used otherwise). */
  venues?: Readonly<Record<string, Venue>>;
  /** Cities other than this get named: "Patronaat in Haarlem" (default Amsterdam). */
  homeCity?: string;
  timeZone?: string;
  probabilities?: Partial<AnnouncerProbabilities>;
}

export interface TrackAnnouncementInput {
  entry: QueueEntry;
  trackIndex: number;
  mode: VoiceMode;
  now: Date;
  /** The artist the listener last heard an intro for (undefined at the start). */
  announcedArtistKey?: string | undefined;
}

/** The longest song title worth saying out loud. */
export const MAX_SPOKEN_TITLE = 70;

interface GigCtx {
  name: string;
  song: string | null;
  where: string;
  day: SpokenDay;
  /** ", at 8.30pm" or "". */
  at: string;
  /** For support acts: who they're supporting. */
  headliner: string | null;
}

export interface PriceCtx {
  price: string;
  range: boolean;
}

interface MicroCtx {
  name: string;
  song: string | null;
  nth: string | null;
}

export const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

// ---------- phrase banks ----------

const NAME_ONLY: Template<GigCtx>[] = [
  (c) => `${c.name}. ${c.where}, ${c.day.bare}.`,
  (c) => `${c.name}, at ${c.where} ${c.day.phrase}.`,
  (c) => `${c.name}. ${cap(c.day.bare)}, ${c.where}.`,
  (c) => `${c.name}: ${c.where}, ${c.day.bare}.`,
];

const INTRO: Template<GigCtx>[] = [
  (c) => `You're listening to ${c.name}.`,
  (c) => `This is ${c.name}.`,
  (c) => `On now, ${c.name}.`,
  (c) => `Here's ${c.name}.`,
  (c) => `Next up, ${c.name}.`,
  (c) => c.song && `This is ${c.name}, with ${c.song}.`,
  (c) => c.song && `Here's ${c.song}, by ${c.name}.`,
];

const GIG: Template<GigCtx>[] = [
  (c) => `They play ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => `Catch them at ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => `They're at ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => `${cap(c.day.phrase)}, they're playing ${c.where}.`,
  (c) => `You can see them at ${c.where} ${c.day.phrase}.`,
  (c) => `They're on at ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => c.headliner && `They're supporting ${c.headliner} at ${c.where} ${c.day.phrase}.`,
  (c) => c.headliner && `They open for ${c.headliner} at ${c.where} ${c.day.phrase}${c.at}.`,
];

const LEAD_WITH_GIG: Template<GigCtx>[] = [
  (c) => `Playing ${c.where} ${c.day.phrase}: ${c.name}.`,
  (c) => `At ${c.where} ${c.day.phrase}: ${c.name}.`,
  (c) => `Coming to ${c.where} ${c.day.phrase}, here's ${c.name}.`,
  (c) => `${cap(c.day.bare)} at ${c.where}: ${c.name}.`,
];

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

const MICRO: Template<MicroCtx>[] = [
  (c) => `Another one from ${c.name}.`,
  (c) => `Staying with ${c.name}.`,
  (c) => c.nth && `Here's a ${c.nth} one from ${c.name}.`,
  (c) => c.song && `More from ${c.name}: this is ${c.song}.`,
  (c) => c.song && `Still ${c.name}. This one's called ${c.song}.`,
  (c) => c.song && `And ${c.song}, also by ${c.name}.`,
  (c) => c.song && `${c.name} again, with ${c.song}.`,
];

/** Collapses stray spacing and never returns leftover template debris. */
export function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:])/g, "$1")
    .trim();
}

export class Announcer {
  readonly picker: PhrasePicker;
  readonly #rng: Rng;
  readonly #venues: Readonly<Record<string, Venue>>;
  readonly #homeCity: string;
  readonly #timeZone: string;
  readonly #p: AnnouncerProbabilities;

  constructor(options: AnnouncerOptions) {
    this.#rng = options.rng;
    this.picker = new PhrasePicker(options.rng);
    this.#venues = options.venues ?? {};
    this.#homeCity = options.homeCity ?? "Amsterdam";
    this.#timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    this.#p = { ...DEFAULT_PROBABILITIES, ...options.probabilities };
  }

  #chance(p: number): boolean {
    return this.#rng() < p;
  }

  /** "Paradiso", or "Patronaat in Haarlem" outside the home city. */
  where(gig: Gig): string {
    const venue = this.#venues[gig.venue];
    const name = venue?.name?.trim() || cap(gig.venue);
    const city = (gig.city ?? venue?.city ?? "").trim();
    const home = this.#homeCity.toLowerCase();
    if (!city || city.toLowerCase() === home || name.toLowerCase().includes(city.toLowerCase())) {
      return name;
    }
    return `${name} in ${city}`;
  }

  /** The cleaned title of track `trackIndex`, or null when missing or too long to say. */
  song(entry: QueueEntry, trackIndex: number): string | null {
    const title = entry.tracks[trackIndex]?.title;
    const song = title ? cleanSongTitle(title, entry.name) : "";
    return song && song.length <= MAX_SPOKEN_TITLE ? song : null;
  }

  /** For a support act, the headliner they open for; null otherwise. */
  headliner(entry: QueueEntry): string | null {
    if (entry.role !== "support") return null;
    const top = entry.gig.artists.find((a) => a.role === "headliner" && a.key !== entry.artistKey);
    return top?.name?.trim() || null;
  }

  #gigCtx(entry: QueueEntry, trackIndex: number, now: Date): GigCtx {
    const gig = entry.gig;
    const time = spokenTime(gig.start, this.#timeZone);
    const afternoonOrLater = zonedParts(new Date(gig.start), this.#timeZone).hour >= 12;
    // Always draw, so the random stream doesn't depend on the data.
    const sayTime = this.#chance(this.#p.time);
    return {
      name: entry.name,
      song: this.song(entry, trackIndex),
      where: this.where(gig),
      day: spokenDay(gig.start, now, this.#timeZone),
      at: time && afternoonOrLater && sayTime ? `, at ${time}` : "",
      headliner: this.headliner(entry),
    };
  }

  /** The line about where and when, as used in `short` mode. */
  gigLine(entry: QueueEntry, now: Date): string {
    return tidy(this.picker.render("gig", GIG, this.#gigCtx(entry, 0, now)));
  }

  /** Sold out, few left, free, not on sale yet, or (sometimes) the price. May be "". */
  ticketNote(gig: Gig): string {
    const status = gig.status === "postponed" ? this.picker.pick("postponed", POSTPONED) : "";
    return tidy(`${status} ${this.#availabilityNote(gig)}`);
  }

  #availabilityNote(gig: Gig): string {
    switch (gig.availability) {
      case "sold_out":
        return this.picker.pick("sold", SOLD_OUT);
      case "few_left":
        return this.picker.pick("few", FEW_LEFT);
      case "free":
        return this.picker.pick("free", FREE);
      case "not_yet_on_sale":
        return this.picker.pick("notyet", NOT_YET);
      default:
        break;
    }
    const min = gig.price?.min_eur;
    if (min === 0 && !(typeof gig.price?.max_eur === "number" && gig.price.max_eur > 0)) {
      return this.picker.pick("free", FREE);
    }
    const sayPrice = this.#chance(this.#p.price);
    const price = spokenPrice(min);
    if (!price || !sayPrice) return "";
    const max = gig.price?.max_eur;
    // "From" wording when the dearest ticket is a whole euro or more above the cheapest.
    const range =
      typeof max === "number" &&
      Number.isFinite(max) &&
      typeof min === "number" &&
      Math.round(max) > Math.round(min);
    return this.picker.render("price", PRICE, { price, range });
  }

  /** What to say when a new artist comes on. */
  artistIntro(entry: QueueEntry, mode: "name" | "short", now: Date, trackIndex = 0): string {
    const ctx = this.#gigCtx(entry, trackIndex, now);
    if (mode === "name") {
      const sold = entry.gig.availability === "sold_out" ? " Sold out." : "";
      return tidy(this.picker.render("name", NAME_ONLY, ctx) + sold);
    }
    const lead = this.#chance(this.#p.leadWithGig);
    const text = lead
      ? this.picker.render("lead", LEAD_WITH_GIG, ctx)
      : `${this.picker.render("intro", INTRO, ctx)} ${this.picker.render("gig", GIG, ctx)}`;
    return tidy(`${text} ${this.ticketNote(entry.gig)}`);
  }

  /**
   * A short line before another track by the same artist, with probability
   * `probabilities.micro`; null otherwise (and for the first track).
   */
  micro(entry: QueueEntry, trackIndex: number): string | null {
    if (trackIndex < 1 || !entry.tracks[trackIndex]) return null;
    if (!this.#chance(this.#p.micro)) return null;
    const ctx: MicroCtx = {
      name: entry.name,
      song: this.song(entry, trackIndex),
      nth: ordinalWord(trackIndex + 1) ?? null,
    };
    return tidy(this.picker.render("micro", MICRO, ctx)) || null;
  }

  /**
   * The announcement (if any) for a track about to play: an intro when the artist
   * differs from `announcedArtistKey`, else maybe a micro-announcement (short mode).
   */
  forTrack(input: TrackAnnouncementInput): string | null {
    const { entry, trackIndex, mode, now } = input;
    if (mode === "off") return null;
    if (entry.artistKey !== input.announcedArtistKey) {
      return this.artistIntro(entry, mode, now, trackIndex);
    }
    return mode === "short" ? this.micro(entry, trackIndex) : null;
  }
}
