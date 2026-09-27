import { unitHash } from "../src/random.ts";
import type { Artist } from "../src/types.ts";

/** Synthetic artists.json records: varied, sometimes sparse, sometimes junky. */

const AREAS: readonly [string | null, string | null, string | null][] = [
  // [country, area, begin_area]
  ["GB", "United Kingdom", "Glasgow"],
  ["GB", "Scotland", null],
  ["NO", "Norway", "Bergen"],
  ["NL", "Netherlands", "Amsterdam"],
  ["US", "United States", "Brooklyn"],
  ["US", null, null],
  [null, "Worldwide", null],
  ["BE", "Belgium", "Ghent"],
  [null, null, null],
  ["FR", "Paris", null],
  ["XE", "Europe", null],
  ["JP", "Japan", "Tokyo"],
];
const TYPES = ["Group", "Person", "Group", "Orchestra", null, "Choir", "Other", "Group"];
const GENRES = [
  ["post-rock", "ambient"],
  ["shoegaze"],
  [],
  ["jazz", "free improvisation"],
  ["hip hop", "trap"],
  ["singer-songwriter"],
  ["electronic"],
  ["80s synth-pop"],
];
const TAGS = [
  ["seen live", "favorites", "indie rock", "british"],
  ["90s", "grunge", "Seen Live"],
  ["female vocalists", "dream pop", "under 2000 listeners"],
  ["dutch", "nederpop", "2010"],
  ["awesome", "Psychedelic Rock", "love"],
  [],
  ["hip-hop", "R&B", "rap"],
  ["a very very long tag that goes on and on", "k-pop"],
];
const DESCRIPTIONS = [
  "Scottish post-rock band",
  "American singer-songwriter",
  null,
  "Wikimedia disambiguation page",
  "Dutch rock band",
  "British musician (born 1971)",
  "Canadian singer, songwriter and actress from Toronto",
  "Norwegian electronic music duo",
  null,
];
const BEGINS = ["2003", "1995-04-01", null, "2025", "1888", "bogus", "2031", "1972-11"];
const KNOWN = ["Slowdive", "Mogwai", "Radiohead", "Nina Simone", "Beach House", "Boards of Canada"];

function pick<T>(list: readonly T[], seed: number, key: string): T {
  return list[Math.floor(unitHash(seed, key) * list.length)] as T;
}

export const BOARD = KNOWN;

/** A synthetic artist for `key`/`name`, varying with `seed`. */
export function syntheticArtist(key: string, name: string, seed = 0): Artist {
  const h = (salt: string) => unitHash(seed, `${key}:${salt}`);
  const sparse = h("sparse") < 0.15;
  const [country, area, beginArea] = pick(AREAS, seed, `${key}:area`);
  const type = pick(TYPES, seed, `${key}:type`);
  return {
    name,
    musicbrainz: sparse
      ? null
      : {
          type,
          country,
          area,
          begin_area: beginArea,
          begin: pick(BEGINS, seed, `${key}:begin`),
          ended: h("ended") < 0.1,
          genres: pick(GENRES, seed, `${key}:genres`),
          tags: pick(TAGS, seed + 1, `${key}:mbtags`),
        },
    lastfm:
      h("lastfm") < 0.2
        ? null
        : {
            tags: pick(TAGS, seed, `${key}:tags`),
            similar: h("similar") < 0.5 ? [name, pick(KNOWN, seed, `${key}:sim`), "Someone Else"] : ["Nobody Known"],
          },
    wikipedia: h("wiki") < 0.4 ? null : { description: pick(DESCRIPTIONS, seed, `${key}:desc`) },
  };
}
