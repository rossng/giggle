/**
 * The presenter: what a good radio presenter would say, and how long it may take.
 *
 * A new-artist link is the gig (where and when) plus at most ONE colour fact from the
 * artist's fact pool (`facts.ts`): where they're from, how long they've been going,
 * a genre, "if you like …" (only for artists on the listener's board), who they're
 * playing with, notable ticket news, or the song. The fact is picked with the seeded
 * rng, preferring facts not yet said about that artist (`said.ts`), so repeat plays
 * rotate through what's known. Every line is kept inside a spoken-length budget:
 * intros aim for 5–9 s and never pass 12 s (the colour fact goes first, then the gig
 * line gets shorter), micro-announcements ≤ 3 s, back-announcements ≤ 6 s.
 *
 * A "quick" intro is one said at once rather than prepared ahead (the listener skipped
 * to an artist): it opens with a short naming sentence ("Here's Mogwai."), so a live
 * voice that renders sentence by sentence can start talking sooner. Same facts, same
 * rotation, same budgets; only which sentence comes first differs.
 *
 * `planSegment` (timing.ts) then decides when to say each line relative to the music.
 */

import { cap, FEW_LEFT, FREE, NOT_YET, POSTPONED, PRICE, SOLD_OUT, spokenSong, spokenWhere, tidy, type VoiceMode } from "./announcer.ts";
import {
  article,
  factPool,
  KnownArtists,
  type ActNoun,
  type ColourFact,
  type FactKind,
  type FormedFact,
  type GenreFact,
  type OriginFact,
  type SimilarFact,
  type SupportFact,
  type TicketFact,
  type TrackFact,
} from "./facts.ts";
import { PhrasePicker, type Template } from "./picker.ts";
import type { QueueEntry } from "./queue.ts";
import type { Rng } from "./random.ts";
import { recordSaid, saidOrder, type SaidMemory } from "./said.ts";
import { estimateSeconds, type SpeechRate } from "./speech.ts";
import { EVENING_HOUR, ordinalWord, spokenDay, spokenTime, type SpokenDay } from "./spoken.ts";
import { DEFAULT_TIME_ZONE, zonedParts } from "./time.ts";
import type { Venue } from "./types.ts";

export type LineKind = "intro" | "micro" | "back";

/** One thing to say, with its estimated length. */
export interface Line {
  kind: LineKind;
  text: string;
  /** `estimateSeconds(text)` at the presenter's speech rate. */
  seconds: number;
  /** What it covers: "gig" plus the colour fact, if any. */
  facts: FactKind[];
  artistKey: string;
  /** The voice mode it was written for. */
  mode: "name" | "short";
  /** A pre-rendered clip to play first ("Next up, Djavan, a Brazilian singer-songwriter…");
   * `spoken` is then the only part to synthesise live. `seconds` covers both. */
  clip?: { url: string; text: string; seconds: number; spoken: string };
}

/** A pre-rendered artist intro from the pipeline: "Next up, <name>, <descriptor>." */
export interface IntroClip {
  url: string;
  text: string;
  seconds: number;
}

/** Spoken-length budgets, in seconds. */
export interface Budgets {
  /** New-artist links aim for this range… */
  introMin: number;
  introMax: number;
  /** …and are never longer than this. */
  introCap: number;
  /** "Name" mode links are spoken over the intro, so stay short. */
  nameCap: number;
  microCap: number;
  backCap: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  introMin: 5,
  introMax: 9,
  introCap: 12,
  nameCap: 6,
  microCap: 3,
  backCap: 6,
};

export interface PresenterProbabilities {
  /** Adding a colour fact to a new-artist link, when there is one (default 0.85). */
  colour: number;
  /** A micro-announcement before another track by the same artist (default 0.5). */
  micro: number;
  /** A back-announcement for a track whose title wasn't said going in (default 0.3). */
  back: number;
}

export const DEFAULT_PRESENTER_PROBABILITIES: PresenterProbabilities = {
  colour: 0.85,
  micro: 0.5,
  back: 0.3,
};

export interface PresenterOptions {
  rng: Rng;
  venues?: Readonly<Record<string, Venue>>;
  homeCity?: string;
  timeZone?: string;
  /** Artist names the listener knows (their board), for "if you like …". */
  knownArtists?: Iterable<string>;
  /** What was said before (persisted next to the play history). */
  said?: SaidMemory;
  speech?: Partial<SpeechRate>;
  budgets?: Partial<Budgets>;
  probabilities?: Partial<PresenterProbabilities>;
}

export interface PresenterTrackInput {
  entry: QueueEntry;
  trackIndex: number;
  mode: VoiceMode;
  now: Date;
  /** The artist the listener last heard an intro for (undefined at the start). */
  announcedArtistKey?: string | undefined;
  /** A pre-rendered intro for this artist, if the pipeline made one. Used in "short"
   * mode: the clip introduces the artist, and only the gig line is said live. */
  clip?: IntroClip | undefined;
  /** It's said at once, not prepared ahead: a new-artist link opens with a short
   * naming sentence (see `intro`). */
  quick?: boolean | undefined;
}

// ---------- phrase contexts ----------

interface GigCtx {
  name: string;
  where: string;
  day: SpokenDay;
  /** ", at 2:30pm" (afternoon gigs) or "". */
  at: string;
}

interface FactCtx<F> {
  name: string;
  fact: F;
  /** For genre facts: the genre picked this time. */
  genre?: string;
}

type Structure = "opener" | "after_gig" | "gig_lead" | "gig_last";

/** Weighted, in the order tried when a fact has no opener. */
const STRUCTURES: readonly (readonly [Structure, number])[] = [
  ["opener", 0.35],
  ["after_gig", 0.3],
  ["gig_lead", 0.2],
  ["gig_last", 0.15],
];

// ---------- phrase banks ----------

// Intros look ahead ("Next up", "Here's"), never "This is" or "You're listening to": said
// in the gap after a track, those could be about the one that just ended.
const PLAIN: Template<{ name: string }>[] = [
  (c) => `Here's ${c.name}.`,
  (c) => `Next up, ${c.name}.`,
  (c) => `Up next, ${c.name}.`,
  (c) => `And now, ${c.name}.`,
];
/** The shortest namings: how a quick intro opens. */
const QUICK_PLAIN = PLAIN.slice(0, 3);

const GIG: Template<GigCtx>[] = [
  (c) => `They play ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => `Catch them at ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => `They're at ${c.where} ${c.day.phrase}${c.at}.`,
  (c) => `${cap(c.day.phrase)}, they're playing ${c.where}.`,
  (c) => `You can see them at ${c.where} ${c.day.phrase}.`,
  (c) => `They're on at ${c.where} ${c.day.phrase}${c.at}.`,
];

const GIG_LEAD: Template<GigCtx>[] = [
  (c) => `Playing ${c.where} ${c.day.phrase}: ${c.name}.`,
  (c) => `At ${c.where} ${c.day.phrase}: ${c.name}.`,
  (c) => `Coming to ${c.where} ${c.day.phrase}, here's ${c.name}.`,
  (c) => `${cap(c.day.bare)} at ${c.where}: ${c.name}.`,
];

/** The shortest gig line there is, for when everything else is too long. */
const GIG_MINIMAL: Template<GigCtx>[] = [
  (c) => `${c.name}, at ${c.where} ${c.day.phrase}.`,
  (c) => `${c.name}. ${c.where}, ${c.day.bare}.`,
];

const NAME_ONLY: Template<GigCtx>[] = [
  (c) => `${c.name}. ${c.where}, ${c.day.bare}.`,
  (c) => `${c.name}, at ${c.where} ${c.day.phrase}.`,
  (c) => `${c.name}. ${cap(c.day.bare)}, ${c.where}.`,
  (c) => `${c.name}: ${c.where}, ${c.day.bare}.`,
];

interface MicroCtx {
  name: string;
  song: string | null;
  nth: string | null;
}

const MICRO: Template<MicroCtx>[] = [
  (c) => `Another one from ${c.name}.`,
  (c) => `Staying with ${c.name}.`,
  (c) => `More ${c.name}.`,
  (c) => c.nth && `A ${c.nth} one from ${c.name}.`,
  (c) => c.song && `More from ${c.name}: ${c.song}.`,
  (c) => c.song && `Still ${c.name}. Here's ${c.song}.`,
  (c) => c.song && `${c.name} again, with ${c.song}.`,
  (c) => c.song && `And another from ${c.name}: ${c.song}.`,
];
/** Indices of MICRO that don't say the song. */
const MICRO_SHORT = MICRO.slice(0, 4);

interface BackCtx {
  name: string;
  song: string | null;
}

const BACK: Template<BackCtx>[] = [
  (c) => c.song && `That was ${c.song}, by ${c.name}.`,
  (c) => c.song && `That was ${c.name}, with ${c.song}.`,
  (c) => c.song && `${c.name} there, with ${c.song}.`,
  (c) => c.song && `You heard ${c.song}, from ${c.name}.`,
];
const BACK_SHORT: Template<BackCtx>[] = [(c) => `That was ${c.name}.`, (c) => `${c.name} there.`];

/** "a post-rock band", or just "a singer-songwriter" when the genre names the act. */
function genreAct(genre: string, noun: ActNoun): string {
  const phrase = /(songwriter|rapper|producer|dj|singer|orchestra|choir|band|ensemble|collective)$/i.test(genre)
    ? genre
    : `${genre} ${noun}`;
  return `${article(phrase)} ${phrase}`;
}

/** Whether "They're a …" reads well: groups yes, "They're a singer" no. */
function plural(phrase: string): boolean {
  return /(band|group|duo|trio|quartet|quintet|collective|ensemble|orchestra|choir)$/i.test(phrase);
}

function demonymAct(o: OriginFact): string | null {
  return o.demonym ? `${article(o.demonym)} ${o.demonym} ${o.noun}` : null;
}

function names(list: readonly string[]): string {
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : (list[0] ?? "");
}

const ORIGIN_OPEN: Template<FactCtx<OriginFact>>[] = [
  (c) => c.fact.place && !c.fact.local && `From ${c.fact.place}, here's ${c.name}.`,
  (c) => c.fact.place && !c.fact.local && `Here's ${c.name}, from ${c.fact.place}.`,
  (c) => c.fact.demonym && !c.fact.local && `Here's ${c.fact.demonym} ${c.fact.noun} ${c.name}.`,
  (c) => !c.fact.local && demonymAct(c.fact) && `Next up, ${c.name}, ${demonymAct(c.fact)}.`,
  (c) => c.fact.local && `Here's local ${c.fact.noun} ${c.name}.`,
  (c) => c.fact.local && `From right here in ${c.fact.place}, here's ${c.name}.`,
];
const ORIGIN_SAY: Template<FactCtx<OriginFact>>[] = [
  (c) => c.fact.place && !c.fact.local && `They're from ${c.fact.place}.`,
  (c) => c.fact.place && !c.fact.local && `They come from ${c.fact.place}.`,
  (c) => !c.fact.local && plural(c.fact.noun) && demonymAct(c.fact) && `They're ${demonymAct(c.fact)}.`,
  (c) => c.fact.local && `They're from right here in ${c.fact.place}.`,
  (c) => c.fact.local && `A home-town ${c.fact.noun}, this one.`,
];

const FORMED_OPEN: Template<FactCtx<FormedFact>>[] = [
  (c) => !c.fact.recent && !c.fact.founded && `Here's ${c.name}, together since ${c.fact.year}.`,
  (c) => !c.fact.recent && !c.fact.founded && `Together since ${c.fact.year}, here's ${c.name}.`,
  (c) => c.fact.recent && !c.fact.founded && `Here's ${c.name}, a brand-new band.`,
  (c) => c.fact.founded && `Here's ${c.name}, founded in ${c.fact.year}.`,
];
const FORMED_SAY: Template<FactCtx<FormedFact>>[] = [
  (c) => !c.fact.recent && !c.fact.founded && `They've been together since ${c.fact.year}.`,
  (c) => !c.fact.recent && !c.fact.founded && `They formed back in ${c.fact.year}.`,
  (c) => !c.fact.recent && !c.fact.founded && `They got together in ${c.fact.year}.`,
  (c) => c.fact.recent && !c.fact.founded && `They only formed in ${c.fact.year}.`,
  (c) => c.fact.recent && !c.fact.founded && `They're a brand-new band.`,
  (c) => c.fact.founded && `They were founded in ${c.fact.year}.`,
];

const GENRE_OPEN: Template<FactCtx<GenreFact>>[] = [
  (c) => c.genre && `Here's ${c.name}, ${genreAct(c.genre, c.fact.noun)}.`,
  (c) => c.genre && `Something on the ${c.genre} side next, from ${c.name}.`,
  (c) => c.fact.descriptor && `Next up, ${c.name}, ${c.fact.descriptor}.`,
  (c) => c.fact.descriptor && `Here's ${c.name}: ${c.fact.descriptor}.`,
];
const GENRE_SAY: Template<FactCtx<GenreFact>>[] = [
  (c) => c.genre && `File under ${c.genre}.`,
  (c) => c.genre && plural(genreAct(c.genre, c.fact.noun)) && `They're ${genreAct(c.genre, c.fact.noun)}.`,
  (c) => c.genre && `It's on the ${c.genre} side of things.`,
  (c) => c.fact.descriptor && plural(c.fact.descriptor) && `They're ${c.fact.descriptor}.`,
];

const SIMILAR_OPEN: Template<FactCtx<SimilarFact>>[] = [
  (c) => `If you like ${c.fact.like}, you'll like ${c.name}.`,
  (c) => `For fans of ${c.fact.like}, here's ${c.name}.`,
  (c) => `One for ${c.fact.like} fans: ${c.name}.`,
];
const SIMILAR_SAY: Template<FactCtx<SimilarFact>>[] = [
  (c) => `If you like ${c.fact.like}, you'll like this.`,
  (c) => `One for ${c.fact.like} fans.`,
  (c) => `Fans of ${c.fact.like}, this one's for you.`,
];

const SUPPORT_OPEN: Template<FactCtx<SupportFact>>[] = [
  (c) => c.fact.supporting && `Here's ${c.name}, supporting ${c.fact.supporting}.`,
  (c) => c.fact.supporting && `Opening for ${c.fact.supporting}, here's ${c.name}.`,
  (c) => c.fact.supportedBy.length > 0 && `Here's ${c.name}, with ${names(c.fact.supportedBy)} in support.`,
];
const SUPPORT_SAY: Template<FactCtx<SupportFact>>[] = [
  (c) => c.fact.supporting && `They're supporting ${c.fact.supporting}.`,
  (c) => c.fact.supporting && `They open for ${c.fact.supporting}.`,
  (c) => c.fact.supportedBy.length > 0 && `Support comes from ${names(c.fact.supportedBy)}.`,
  (c) => c.fact.supportedBy.length > 0 && `Get there early for ${names(c.fact.supportedBy)}.`,
];

const TRACK_OPEN: Template<FactCtx<TrackFact>>[] = [
  (c) => `Next up, ${c.name}, with ${c.fact.song}.`,
  (c) => `Here's ${c.fact.song}, by ${c.name}.`,
  (c) => `Here's ${c.name}, with ${c.fact.song}.`,
];
const TRACK_SAY: Template<FactCtx<TrackFact>>[] = [
  (c) => `This one's called ${c.fact.song}.`,
  (c) => `Here's ${c.fact.song}.`,
  (c) => `The song is ${c.fact.song}.`,
];

const TICKET_BANKS: Readonly<Record<Exclude<TicketFact["news"], "price">, readonly string[]>> = {
  postponed: POSTPONED,
  sold_out: SOLD_OUT,
  few_left: FEW_LEFT,
  free: FREE,
  not_yet: NOT_YET,
};

export class Presenter {
  readonly #picker: PhrasePicker;
  readonly budgets: Budgets;
  readonly #rng: Rng;
  readonly #timeZone: string;
  readonly #homeCity: string;
  readonly #venues: Readonly<Record<string, Venue>>;
  readonly #speech: Partial<SpeechRate>;
  readonly #p: PresenterProbabilities;
  #known: KnownArtists;
  #said: SaidMemory;
  /** videoIds whose title was said going in (no need to back-announce them). */
  readonly #named: string[] = [];

  constructor(options: PresenterOptions) {
    this.#rng = options.rng;
    this.#timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    this.#homeCity = options.homeCity ?? "Amsterdam";
    this.#picker = new PhrasePicker(options.rng);
    this.#venues = options.venues ?? {};
    this.budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
    this.#speech = options.speech ?? {};
    this.#p = { ...DEFAULT_PRESENTER_PROBABILITIES, ...options.probabilities };
    this.#known = new KnownArtists(options.knownArtists ?? []);
    this.#said = options.said ?? {};
  }

  /** What's been said about whom: persist this next to the play history. */
  get said(): SaidMemory {
    return this.#said;
  }

  set said(memory: SaidMemory) {
    this.#said = memory;
  }

  /** Replaces the names used for "if you like …" (e.g. when the board changes). */
  setKnownArtists(names: Iterable<string>): void {
    this.#known = new KnownArtists(names);
  }

  /** Estimated seconds to say `text` at this presenter's speech rate. */
  estimate(text: string): number {
    return estimateSeconds(text, this.#speech);
  }

  #chance(p: number): boolean {
    return this.#rng() < p;
  }

  #line(kind: LineKind, text: string, entry: QueueEntry, facts: FactKind[], mode: "name" | "short"): Line {
    text = tidy(text);
    return { kind, text, seconds: this.estimate(text), facts, artistKey: entry.artistKey, mode };
  }

  /** The colour facts available for a track, before any are picked. */
  facts(entry: QueueEntry, trackIndex: number, now: Date): ColourFact[] {
    return factPool({
      entry,
      song: spokenSong(entry, trackIndex),
      now,
      knownArtists: this.#known,
      homeCity: this.#homeCity,
    });
  }

  /**
   * Picks at most one colour fact: never-said kinds first (weighted), then the ones
   * said longest ago, never the kind said last time when there's another.
   */
  #pickFact(pool: readonly ColourFact[], artistKey: string): ColourFact | null {
    const wantsColour = this.#chance(this.#p.colour);
    if (!pool.length || !wantsColour) return null;
    const order = saidOrder(this.#said, artistKey);
    let candidates = pool.filter((f) => !order.has(f.kind));
    if (!candidates.length) {
      const byAge = [...pool].sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0));
      candidates = byAge.slice(0, Math.max(1, Math.ceil(byAge.length / 2)));
    }
    const total = candidates.reduce((sum, f) => sum + f.weight, 0);
    let r = this.#rng() * total;
    for (const f of candidates) {
      r -= f.weight;
      if (r < 0) return f;
    }
    return candidates[candidates.length - 1] ?? null;
  }

  /**
   * Where and when, at a level of detail: 0 full, 1 no time, 2 no weekday on dates.
   * The start time only for an afternoon gig: evening starts go without saying.
   */
  #gigCtx(entry: QueueEntry, now: Date, level: number): GigCtx {
    const gig = entry.gig;
    let day = spokenDay(gig.start, now, this.#timeZone);
    if (level >= 2 && day.kind === "date") {
      const bare = day.bare.replace(/^\p{L}+day /u, "");
      day = { kind: "date", bare, phrase: `on ${bare}` };
    }
    const time = spokenTime(gig.start, this.#timeZone);
    const hour = zonedParts(new Date(gig.start), this.#timeZone).hour;
    const afternoon = hour >= 12 && hour < EVENING_HOUR;
    const at = level === 0 && time && afternoon ? `, at ${time}` : "";
    return { name: entry.name, where: spokenWhere(gig, this.#venues, this.#homeCity), day, at };
  }

  #genreCtx(entry: QueueEntry, fact: GenreFact): FactCtx<GenreFact> {
    const i = fact.genres.length > 1 && this.#rng() < 0.35 ? 1 : 0;
    const genre = fact.genres[i];
    return genre ? { name: entry.name, fact, genre } : { name: entry.name, fact };
  }

  /** The fact as an opening sentence that names the artist; "" if it has none. */
  #opener(entry: QueueEntry, fact: ColourFact): string {
    const r = this.#picker;
    const name = entry.name;
    switch (fact.kind) {
      case "origin":
        return r.render("p.origin.open", ORIGIN_OPEN, { name, fact });
      case "formed":
        return r.render("p.formed.open", FORMED_OPEN, { name, fact });
      case "genre":
        return r.render("p.genre.open", GENRE_OPEN, this.#genreCtx(entry, fact));
      case "similar":
        return r.render("p.similar.open", SIMILAR_OPEN, { name, fact });
      case "support":
        return r.render("p.support.open", SUPPORT_OPEN, { name, fact });
      case "track":
        return r.render("p.track.open", TRACK_OPEN, { name, fact });
      case "ticket":
        return "";
    }
  }

  /** The fact as a sentence about "them", once they've been named. */
  #sentence(entry: QueueEntry, fact: ColourFact): string {
    const r = this.#picker;
    const name = entry.name;
    switch (fact.kind) {
      case "origin":
        return r.render("p.origin.say", ORIGIN_SAY, { name, fact });
      case "formed":
        return r.render("p.formed.say", FORMED_SAY, { name, fact });
      case "genre":
        return r.render("p.genre.say", GENRE_SAY, this.#genreCtx(entry, fact));
      case "similar":
        return r.render("p.similar.say", SIMILAR_SAY, { name, fact });
      case "support":
        return r.render("p.support.say", SUPPORT_SAY, { name, fact });
      case "track":
        return r.render("p.track.say", TRACK_SAY, { name, fact });
      case "ticket":
        if (fact.news === "price") {
          return fact.price ? r.render("p.price", PRICE, { price: fact.price, range: !!fact.range }) : "";
        }
        return r.pick(`p.${fact.news}`, TICKET_BANKS[fact.news]);
    }
  }

  #structure(fact: ColourFact | null, quick: boolean): Structure {
    if (!fact) return !quick && this.#chance(0.25) ? "gig_lead" : "after_gig";
    // Ticket news only makes sense once the gig's been mentioned. A quick intro opens
    // with a plain naming.
    const allowed = STRUCTURES.filter(
      ([s]) =>
        (fact.kind !== "ticket" || s === "after_gig" || s === "gig_lead") &&
        (!quick || s === "after_gig" || s === "gig_last"),
    );
    const total = allowed.reduce((sum, [, w]) => sum + w, 0);
    let r = this.#rng() * total;
    for (const [s, w] of allowed) {
      r -= w;
      if (r < 0) return s;
    }
    return "after_gig";
  }

  #compose(entry: QueueEntry, fact: ColourFact | null, structure: Structure, gig: GigCtx, quick: boolean): string {
    const r = this.#picker;
    const name = { name: entry.name };
    const plain = (): string => (quick ? r.render("p.plain.quick", QUICK_PLAIN, name) : r.render("p.plain", PLAIN, name));
    const gigSay = (): string => r.render("p.gig", GIG, gig);
    const gigLead = (): string => r.render("p.lead", GIG_LEAD, gig);
    if (!fact) return tidy(structure === "gig_lead" ? gigLead() : `${plain()} ${gigSay()}`);
    switch (structure) {
      case "opener": {
        const open = this.#opener(entry, fact);
        return open ? tidy(`${open} ${gigSay()}`) : tidy(`${plain()} ${gigSay()} ${this.#sentence(entry, fact)}`);
      }
      case "after_gig":
        return tidy(`${plain()} ${gigSay()} ${this.#sentence(entry, fact)}`);
      case "gig_lead":
        return tidy(`${gigLead()} ${this.#sentence(entry, fact)}`);
      case "gig_last":
        return tidy(`${plain()} ${this.#sentence(entry, fact)} ${gigSay()}`);
    }
  }

  /**
   * A new-artist link: the gig, plus at most one colour fact, within the budget.
   * `quick`: it opens with a short naming sentence ("Here's Mogwai.").
   */
  intro(entry: QueueEntry, mode: "name" | "short", now: Date, trackIndex = 0, { quick = false } = {}): Line {
    const b = this.budgets;
    if (mode === "name") return this.#nameIntro(entry, now);

    const fact = this.#pickFact(this.facts(entry, trackIndex, now), entry.artistKey);
    let best: { text: string; seconds: number; fact: ColourFact | null } | null = null;
    /** Keeps the shortest line under the cap; true when it's within the target. */
    const consider = (text: string, f: ColourFact | null): boolean => {
      const seconds = this.estimate(text);
      if (seconds <= b.introCap && (!best || seconds < best.seconds)) best = { text, seconds, fact: f };
      return seconds <= b.introMax;
    };
    // Up to three tries at a line within the target, each with a shorter gig line
    // (no start time, then no weekday on far-off dates). Lines under the target's
    // lower end are fine: retrying can't add facts that aren't there.
    let done = false;
    for (let level = 0; level < 3 && !done; level++) {
      const gig = this.#gigCtx(entry, now, level);
      done = consider(this.#compose(entry, fact, this.#structure(fact, quick), gig, quick), fact);
    }
    // Still over the cap: drop the colour fact.
    for (let level = 1; level <= 2 && !best && fact; level++) {
      const gig = this.#gigCtx(entry, now, level);
      consider(this.#compose(entry, null, this.#structure(null, quick), gig, quick), null);
    }
    if (!best) {
      const text = this.#shortest(GIG_MINIMAL, this.#gigCtx(entry, now, 2));
      best = { text, seconds: this.estimate(text), fact: null };
    }
    const chosen = best as { text: string; seconds: number; fact: ColourFact | null };
    const facts: FactKind[] = ["gig"];
    if (chosen.fact) {
      facts.push(chosen.fact.kind);
      this.#said = recordSaid(this.#said, entry.artistKey, [chosen.fact.kind], now);
      if (chosen.fact.kind === "track") this.#rememberNamed(entry, trackIndex);
    }
    const text = tidy(chosen.text);
    return { kind: "intro", text, seconds: this.estimate(text), facts, artistKey: entry.artistKey, mode };
  }

  /** A new-artist intro that starts with the pipeline's clip and follows it with a short
   * live gig line ("They play Paradiso tonight."). The clip already names the artist, so
   * the gig line doesn't; the pair stays within the intro cap. */
  clipIntro(entry: QueueEntry, clip: IntroClip, now: Date): Line {
    const b = this.budgets;
    let spoken = "";
    for (let level = 0; level <= 2; level++) {
      const ctx = this.#gigCtx(entry, now, level);
      spoken = tidy(this.#picker.render("p.gig", GIG, ctx));
      if (clip.seconds + this.estimate(spoken) <= b.introCap) break;
    }
    const sold = entry.gig.availability === "sold_out" ? " It's sold out." : "";
    if (sold && clip.seconds + this.estimate(spoken + sold) <= b.introCap) spoken += sold;
    const seconds = clip.seconds + this.estimate(spoken);
    return {
      kind: "intro",
      text: tidy(`${clip.text} ${spoken}`),
      seconds,
      facts: ["gig"],
      artistKey: entry.artistKey,
      mode: "short",
      clip: { url: clip.url, text: clip.text, seconds: clip.seconds, spoken },
    };
  }

  #nameIntro(entry: QueueEntry, now: Date): Line {
    const sold = entry.gig.availability === "sold_out" ? " Sold out." : "";
    const limit = this.budgets.nameCap;
    let text = tidy(this.#picker.render("p.name", NAME_ONLY, this.#gigCtx(entry, now, 1)) + sold);
    if (this.estimate(text) > limit) {
      const short = this.#gigCtx(entry, now, 2);
      text = this.#shortest(NAME_ONLY, short, sold);
      if (this.estimate(text) > limit) text = this.#shortest(NAME_ONLY, short);
    }
    return this.#line("intro", text, entry, ["gig"], "name");
  }

  /** The shortest wording that fits, when the budget matters more than variety. */
  #shortest<C>(templates: readonly Template<C>[], ctx: C, suffix = ""): string {
    let best = "";
    let bestSeconds = Infinity;
    for (const t of templates) {
      const rendered = t(ctx);
      if (!rendered) continue;
      const text = tidy(rendered + suffix);
      const seconds = this.estimate(text);
      if (seconds < bestSeconds) {
        best = text;
        bestSeconds = seconds;
      }
    }
    return best;
  }

  #rememberNamed(entry: QueueEntry, trackIndex: number): void {
    const id = entry.tracks[trackIndex]?.videoId;
    if (!id) return;
    this.#named.push(id);
    if (this.#named.length > 50) this.#named.shift();
  }

  /** A line (≤ `microCap`) before another track by the same artist, sometimes. */
  micro(entry: QueueEntry, trackIndex: number): Line | null {
    if (trackIndex < 1 || !entry.tracks[trackIndex]) return null;
    if (!this.#chance(this.#p.micro)) return null;
    const song = spokenSong(entry, trackIndex);
    const ctx: MicroCtx = { name: entry.name, song, nth: ordinalWord(trackIndex + 1) ?? null };
    const r = this.#picker;
    let text = tidy(r.render("p.micro", MICRO, ctx));
    let named = !!song && text.includes(song);
    if (this.estimate(text) > this.budgets.microCap) {
      text = tidy(r.render("p.micro", MICRO_SHORT, ctx));
      named = false;
    }
    if (!text || this.estimate(text) > this.budgets.microCap) return null;
    if (named) this.#rememberNamed(entry, trackIndex);
    return this.#line("micro", text, entry, named ? ["track"] : [], "short");
  }

  /**
   * "That was Tidewater, by Mike.": sometimes, over the end of a track whose title
   * wasn't said on the way in. Null otherwise, or when even the short form is too long.
   */
  backAnnounce(entry: QueueEntry, trackIndex: number): Line | null {
    const track = entry.tracks[trackIndex];
    if (!track || !this.#chance(this.#p.back) || this.#named.includes(track.videoId)) return null;
    const ctx: BackCtx = { name: entry.name, song: spokenSong(entry, trackIndex) };
    const r = this.#picker;
    let text = tidy(r.render("p.back", BACK, ctx));
    let facts: FactKind[] = ["track"];
    if (!text || this.estimate(text) > this.budgets.backCap) {
      text = tidy(r.render("p.back.short", BACK_SHORT, ctx));
      facts = [];
    }
    if (this.estimate(text) > this.budgets.backCap) return null;
    return this.#line("back", text, entry, facts, "short");
  }

  /**
   * The line (if any) for a track about to play: an intro when the artist differs
   * from `announcedArtistKey`, else maybe a micro-announcement (short mode only).
   */
  forTrack(input: PresenterTrackInput): Line | null {
    const { entry, trackIndex, mode, now } = input;
    if (mode === "off") return null;
    if (entry.artistKey !== input.announcedArtistKey) {
      if (input.clip && mode === "short") return this.clipIntro(entry, input.clip, now);
      return this.intro(entry, mode, now, trackIndex, { quick: !!input.quick });
    }
    return mode === "short" ? this.micro(entry, trackIndex) : null;
  }
}
