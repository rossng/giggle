/**
 * The facts a presenter could say about an artist: a pool built from the artist
 * record (MusicBrainz, Last.fm, Wikipedia), their gig and the track playing. Each
 * announcement uses the gig plus at most one of these "colour" facts; see
 * `presenter.ts`. Everything here is plain data, already cleaned for speech: missing
 * or junk data simply means fewer facts.
 */

import type { QueueEntry } from "./queue.ts";
import { spokenPrice } from "./spoken.ts";
import type { Artist } from "./types.ts";

export type ColourFactKind = "origin" | "formed" | "genre" | "similar" | "support" | "ticket" | "track";
export type FactKind = "gig" | ColourFactKind;

export const COLOUR_FACT_KINDS: readonly ColourFactKind[] = [
  "origin",
  "formed",
  "genre",
  "similar",
  "support",
  "ticket",
  "track",
];

/** What to call the act: "band", "artist", "orchestra", "choir" or "act". */
export type ActNoun = "band" | "artist" | "orchestra" | "choir" | "act";

export type TicketNews = "postponed" | "sold_out" | "few_left" | "free" | "not_yet" | "price";

interface Weighted {
  /** Relative chance of being picked when several facts are fresh. */
  weight: number;
}

export interface OriginFact extends Weighted {
  kind: "origin";
  /** A town or region: "Glasgow". Null when only the country is known. */
  place: string | null;
  /** "Scottish", "Norwegian"; null when unknown. */
  demonym: string | null;
  /** From the home city ("a local band"). */
  local: boolean;
  noun: ActNoun;
}

export interface FormedFact extends Weighted {
  kind: "formed";
  year: number;
  /** Formed this year or last. */
  recent: boolean;
  /** Orchestras and choirs are "founded", not "together since". */
  founded: boolean;
}

export interface GenreFact extends Weighted {
  kind: "genre";
  /** One or two short lower-case genres, best first: ["post-rock", "ambient"]. */
  genres: string[];
  noun: ActNoun;
  /** Wikipedia's short description when it's a clean one: "a Scottish post-rock band". */
  descriptor: string | null;
}

export interface SimilarFact extends Weighted {
  kind: "similar";
  /** An artist the listener knows (from their board) that Last.fm calls similar. */
  like: string;
}

export interface SupportFact extends Weighted {
  kind: "support";
  /** For a support act: the headliner they open for. */
  supporting: string | null;
  /** For a headliner: up to two support acts. */
  supportedBy: string[];
}

export interface TicketFact extends Weighted {
  kind: "ticket";
  news: TicketNews;
  /** For `price`: "17 euros", "about 24 euros". */
  price?: string;
  /** For `price`: whether there are dearer tickets too ("from 17 euros"). */
  range?: boolean;
}

export interface TrackFact extends Weighted {
  kind: "track";
  /** The cleaned song title. */
  song: string;
}

export type ColourFact = OriginFact | FormedFact | GenreFact | SimilarFact | SupportFact | TicketFact | TrackFact;

export const FACT_WEIGHTS: Readonly<Record<ColourFactKind, number>> = {
  origin: 1.2,
  formed: 0.8,
  genre: 1.2,
  similar: 2,
  support: 0.8,
  ticket: 1,
  track: 1,
};

const TICKET_WEIGHTS: Readonly<Record<TicketNews, number>> = {
  postponed: 5,
  sold_out: 4,
  few_left: 2.5,
  free: 1.5,
  not_yet: 0.6,
  price: 0.35,
};

// ---------- places ----------

/** ISO 3166-1 codes → [country name, demonym]. */
const COUNTRIES: Readonly<Record<string, readonly [string, string]>> = {
  AR: ["Argentina", "Argentinian"],
  AT: ["Austria", "Austrian"],
  AU: ["Australia", "Australian"],
  BE: ["Belgium", "Belgian"],
  BG: ["Bulgaria", "Bulgarian"],
  BR: ["Brazil", "Brazilian"],
  CA: ["Canada", "Canadian"],
  CH: ["Switzerland", "Swiss"],
  CL: ["Chile", "Chilean"],
  CN: ["China", "Chinese"],
  CO: ["Colombia", "Colombian"],
  CU: ["Cuba", "Cuban"],
  CZ: ["Czechia", "Czech"],
  DE: ["Germany", "German"],
  DK: ["Denmark", "Danish"],
  EE: ["Estonia", "Estonian"],
  EG: ["Egypt", "Egyptian"],
  ES: ["Spain", "Spanish"],
  ET: ["Ethiopia", "Ethiopian"],
  FI: ["Finland", "Finnish"],
  FR: ["France", "French"],
  GB: ["United Kingdom", "British"],
  GH: ["Ghana", "Ghanaian"],
  GR: ["Greece", "Greek"],
  HR: ["Croatia", "Croatian"],
  HU: ["Hungary", "Hungarian"],
  IE: ["Ireland", "Irish"],
  IL: ["Israel", "Israeli"],
  IN: ["India", "Indian"],
  IR: ["Iran", "Iranian"],
  IS: ["Iceland", "Icelandic"],
  IT: ["Italy", "Italian"],
  JM: ["Jamaica", "Jamaican"],
  JP: ["Japan", "Japanese"],
  KR: ["South Korea", "South Korean"],
  LT: ["Lithuania", "Lithuanian"],
  LU: ["Luxembourg", "Luxembourgish"],
  LV: ["Latvia", "Latvian"],
  MA: ["Morocco", "Moroccan"],
  ML: ["Mali", "Malian"],
  MX: ["Mexico", "Mexican"],
  NG: ["Nigeria", "Nigerian"],
  NL: ["Netherlands", "Dutch"],
  NO: ["Norway", "Norwegian"],
  NZ: ["New Zealand", "New Zealand"],
  PL: ["Poland", "Polish"],
  PT: ["Portugal", "Portuguese"],
  RO: ["Romania", "Romanian"],
  RS: ["Serbia", "Serbian"],
  RU: ["Russia", "Russian"],
  SE: ["Sweden", "Swedish"],
  SI: ["Slovenia", "Slovenian"],
  SN: ["Senegal", "Senegalese"],
  TR: ["Turkey", "Turkish"],
  UA: ["Ukraine", "Ukrainian"],
  US: ["United States", "American"],
  ZA: ["South Africa", "South African"],
};

/** Regions and alternative country names MusicBrainz uses as areas. */
const REGIONS: Readonly<Record<string, string>> = {
  scotland: "Scottish",
  england: "English",
  wales: "Welsh",
  "northern ireland": "Northern Irish",
  "united states of america": "American",
  usa: "American",
  uk: "British",
  "the netherlands": "Dutch",
  holland: "Dutch",
  "czech republic": "Czech",
  flanders: "Flemish",
  catalonia: "Catalan",
  "basque country": "Basque",
  quebec: "Québécois",
};

const COUNTRY_NAMES = new Map<string, string>(
  Object.values(COUNTRIES).map(([name, demonym]) => [name.toLowerCase(), demonym]),
);
const DEMONYMS = new Set<string>(
  [...Object.values(COUNTRIES).map(([, d]) => d), ...Object.values(REGIONS)].map((d) => d.toLowerCase()),
);
/** Areas that aren't places anyone is "from". */
const NON_PLACES = new Set(["worldwide", "europe", "earth", "unknown", "[worldwide]", "[unknown]"]);

/** The demonym for an area name, if it's a country or a known region. */
function areaDemonym(area: string): string | null {
  const a = area.trim().toLowerCase();
  return COUNTRY_NAMES.get(a) ?? REGIONS[a] ?? null;
}

/** A town or region worth saying: letters, spaces, hyphens and apostrophes only. */
function cleanPlace(area: string | null | undefined): string | null {
  const a = area?.trim();
  if (!a || a.length > 32 || NON_PLACES.has(a.toLowerCase())) return null;
  if (!/^[\p{L}][\p{L}\s'’.-]*$/u.test(a)) return null;
  return a;
}

function actNoun(type: string | null | undefined): ActNoun {
  switch (type?.toLowerCase()) {
    case "group":
      return "band";
    case "person":
      return "artist";
    case "orchestra":
      return "orchestra";
    case "choir":
      return "choir";
    default:
      return "act";
  }
}

function originFact(artist: Artist, homeCity: string): OriginFact | null {
  const mb = artist.musicbrainz;
  if (!mb) return null;
  const noun = actNoun(mb.type);
  let place: string | null = null;
  let demonym: string | null = null;
  for (const area of [mb.begin_area, mb.area]) {
    const clean = cleanPlace(area);
    if (!clean) continue;
    const d = areaDemonym(clean);
    if (d) demonym ??= d;
    else place ??= clean;
  }
  const code = mb.country?.trim().toUpperCase();
  if (!demonym && code && COUNTRIES[code]) demonym = COUNTRIES[code][1];
  if (!place && !demonym) return null;
  const local = !!place && place.toLowerCase() === homeCity.trim().toLowerCase();
  return { kind: "origin", place, demonym, local, noun, weight: FACT_WEIGHTS.origin };
}

// ---------- formed ----------

function formedFact(artist: Artist, now: Date): FormedFact | null {
  const mb = artist.musicbrainz;
  const type = mb?.type?.toLowerCase();
  // A Person's "begin" is their birth, and unknown types might be people too.
  if (!mb?.begin || mb.ended || !(type === "group" || type === "orchestra" || type === "choir")) return null;
  const match = /^(\d{4})/.exec(mb.begin);
  const year = match ? Number(match[1]) : Number.NaN;
  const thisYear = now.getUTCFullYear();
  if (!Number.isInteger(year) || year < 1800 || year > thisYear) return null;
  return {
    kind: "formed",
    year,
    recent: year >= thisYear - 1,
    founded: type !== "group",
    weight: FACT_WEIGHTS.formed,
  };
}

// ---------- genre ----------

/** Tags that say something about the listener or the tagger, not the music. */
const JUNK_TAGS = new Set([
  "seen live",
  "live",
  "favorites",
  "favourites",
  "favorite",
  "favourite",
  "favorite artists",
  "favourite artists",
  "favorite bands",
  "favourite bands",
  "love",
  "loved",
  "love at first listen",
  "awesome",
  "beautiful",
  "amazing",
  "cool",
  "best",
  "great",
  "good",
  "epic",
  "sexy",
  "spotify",
  "albums i own",
  "check out",
  "to check out",
  "under 2000 listeners",
  "female vocalists",
  "male vocalists",
  "female vocalist",
  "male vocalist",
  "female vocals",
  "male vocals",
  "all",
  "fip",
  "radio",
  "vinyl",
  "concert",
  "new",
  "cover",
  "covers",
  "music",
  "misc",
  "other",
  "various",
  "various artists",
  "unknown",
  "instrumental",
  "british",
  "uk",
  "usa",
  "us",
  "american",
  "english",
  "scottish",
  "dutch",
  "nederland",
  "nederlands",
  "netherlands",
  "holland",
  "german",
  "deutsch",
  "french",
  "canadian",
  "australian",
  "irish",
  "swedish",
  "norwegian",
]);

/** Decades are fine inside a genre ("80s synth-pop"), but not as the whole phrase. */
const DECADE = /^(?:'?\d0s|(?:19|20)\d0s)$/;

const RENAMES: Readonly<Record<string, string>> = {
  "hip-hop": "hip hop",
  hiphop: "hip hop",
  "r&b": "R&B",
  rnb: "R&B",
  "rhythm and blues": "R&B",
  "drum and bass": "drum and bass",
  "drum n bass": "drum and bass",
  dnb: "drum and bass",
  "singer/songwriter": "singer-songwriter",
  "singer songwriter": "singer-songwriter",
  "post rock": "post-rock",
  "post punk": "post-punk",
  "synthpop": "synth-pop",
  "electronica": "electronica",
};

function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A short, lower-case genre phrase, or null for junk ("seen live", "british", "2010"). */
export function cleanGenre(tag: string | null | undefined, artistName = ""): string | null {
  if (typeof tag !== "string") return null;
  let t = tag.trim().toLowerCase().replace(/\s+/g, " ").replace(/_/g, " ");
  if (!t) return null;
  t = RENAMES[t] ?? t;
  if (JUNK_TAGS.has(t) || DEMONYMS.has(t) || COUNTRY_NAMES.has(t) || DECADE.test(t)) return null;
  if (t.length > 24 || t.split(" ").length > 3) return null;
  // Letters, spaces, hyphens; digits only as a decade ("80s").
  const words = t.split(" ");
  for (const w of words) {
    if (/\d/.test(w) && !DECADE.test(w)) return null;
    if (!/\d/.test(w) && !/^[\p{L}][\p{L}'’&-]*$/u.test(w)) return null;
  }
  if (t !== "R&B" && t.includes("&")) return null;
  if (artistName && normName(t) === normName(artistName)) return null;
  return t;
}

const MUSIC_NOUN =
  /\b(band|group|duo|trio|quartet|quintet|musician|singer|songwriter|singer-songwriter|rapper|producer|dj|composer|pianist|guitarist|saxophonist|trumpeter|drummer|bassist|violinist|cellist|orchestra|ensemble|collective|choir|artist|vocalist)$/i;

/** Wikipedia's short description as a spoken descriptor: "a Scottish post-rock band". */
export function cleanDescriptor(description: string | null | undefined): string | null {
  const d = description?.trim().replace(/\s+/g, " ");
  if (!d || d.length > 48 || d.split(" ").length > 6) return null;
  if (/\d|[()[\]{}:;"“”,]|disambiguation|wikimedia|refer/i.test(d)) return null;
  if (!MUSIC_NOUN.test(d)) return null;
  if (/\band\b/i.test(d) && d.split(" ").length > 4) return null; // "Canadian singer and actress…"
  const first = d.split(" ")[0] ?? "";
  // Keep proper adjectives ("Scottish"), lower-case the rest ("Rock band" → "rock band").
  const text = DEMONYMS.has(first.toLowerCase()) ? d : d.charAt(0).toLowerCase() + d.slice(1);
  return `${article(text)} ${text}`;
}

/** "a" or "an" for the phrase that follows. */
export function article(phrase: string): "a" | "an" {
  const p = phrase.trim().toLowerCase();
  if (/^(8|11|18)(\d{1,2})?0?s?\b/.test(p)) return "an"; // "an 80s", "an 18th"
  if (/^(uni|use|usu|eu|one|once|uk\b|u\.)/.test(p)) return "a";
  if (/^(hour|honest|heir)/.test(p)) return "an";
  if (/^r&b/.test(p)) return "an";
  return /^[aeiou]/.test(p) ? "an" : "a";
}

function genreFact(artist: Artist): GenreFact | null {
  const sources = [
    ...(artist.musicbrainz?.genres ?? []).slice(0, 4),
    ...(artist.lastfm?.tags ?? []).slice(0, 6),
    ...(artist.musicbrainz?.tags ?? []).slice(0, 4),
  ];
  const genres: string[] = [];
  for (const tag of sources) {
    const g = cleanGenre(tag, artist.name);
    if (g && !genres.includes(g)) genres.push(g);
    if (genres.length >= 2) break;
  }
  const descriptor = cleanDescriptor(artist.wikipedia?.description);
  if (!genres.length && !descriptor) return null;
  return {
    kind: "genre",
    genres,
    noun: actNoun(artist.musicbrainz?.type),
    descriptor,
    weight: FACT_WEIGHTS.genre,
  };
}

// ---------- similar ----------

/** A lookup of names the listener knows, normalised ("The Cure" ≈ "cure"). */
export class KnownArtists {
  readonly #names = new Set<string>();

  constructor(names: Iterable<string> = []) {
    for (const n of names) this.add(n);
  }

  add(name: string): void {
    const n = typeof name === "string" ? normName(name) : "";
    if (n) this.#names.add(n);
  }

  has(name: string): boolean {
    return this.#names.has(normName(name));
  }

  get size(): number {
    return this.#names.size;
  }
}

function similarFact(artist: Artist, known: KnownArtists | undefined): SimilarFact | null {
  if (!known?.size) return null;
  const self = normName(artist.name);
  for (const name of artist.lastfm?.similar ?? []) {
    const like = typeof name === "string" ? name.trim() : "";
    if (!like || like.length > 40 || normName(like) === self || !known.has(like)) continue;
    return { kind: "similar", like, weight: FACT_WEIGHTS.similar };
  }
  return null;
}

// ---------- gig-based ----------

function supportFact(entry: QueueEntry): SupportFact | null {
  const others = (entry.gig.artists ?? []).filter((a) => a?.key !== entry.artistKey && a?.name?.trim());
  if (entry.role === "support") {
    const top = others.find((a) => a.role === "headliner");
    return top
      ? { kind: "support", supporting: top.name.trim(), supportedBy: [], weight: FACT_WEIGHTS.support }
      : null;
  }
  const supportedBy = others
    .filter((a) => a.role === "support")
    .map((a) => a.name.trim())
    .filter((n) => n.length <= 40)
    .slice(0, 2);
  return supportedBy.length
    ? { kind: "support", supporting: null, supportedBy, weight: FACT_WEIGHTS.support }
    : null;
}

function ticketFact(entry: QueueEntry): TicketFact | null {
  const gig = entry.gig;
  const make = (news: TicketNews, extra: Partial<TicketFact> = {}): TicketFact => ({
    kind: "ticket",
    news,
    weight: TICKET_WEIGHTS[news] * FACT_WEIGHTS.ticket,
    ...extra,
  });
  if (gig.status === "postponed") return make("postponed");
  switch (gig.availability) {
    case "sold_out":
      return make("sold_out");
    case "few_left":
      return make("few_left");
    case "free":
      return make("free");
    case "not_yet_on_sale":
      return make("not_yet");
    default:
      break;
  }
  const min = gig.price?.min_eur;
  const max = gig.price?.max_eur;
  if (min === 0 && !(typeof max === "number" && max > 0)) return make("free");
  const price = spokenPrice(min);
  if (!price) return null;
  const range =
    typeof max === "number" && Number.isFinite(max) && typeof min === "number" && Math.round(max) > Math.round(min);
  return make("price", { price, range });
}

export interface FactPoolInput {
  entry: QueueEntry;
  /** The cleaned title of the track about to play, if it's worth saying. */
  song?: string | null;
  now: Date;
  /** Names on the listener's board, for "if you like …". */
  knownArtists?: KnownArtists;
  homeCity?: string;
  /** Leave out the price (the gig line may already be long, or prices are off). */
  prices?: boolean;
}

/** Every colour fact available for an entry, in a fixed order. */
export function factPool(input: FactPoolInput): ColourFact[] {
  const { entry, now } = input;
  const artist = entry.artist;
  const facts: (ColourFact | null)[] = [
    artist ? originFact(artist, input.homeCity ?? "Amsterdam") : null,
    artist ? formedFact(artist, now) : null,
    artist ? genreFact(artist) : null,
    artist ? similarFact(artist, input.knownArtists) : null,
    supportFact(entry),
    ticketFact(entry),
    input.song ? { kind: "track", song: input.song, weight: FACT_WEIGHTS.track } : null,
  ];
  return facts.filter((f): f is ColourFact => {
    if (!f) return false;
    return !(f.kind === "ticket" && f.news === "price" && input.prices === false);
  });
}
