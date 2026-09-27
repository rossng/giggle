import { describe, expect, it } from "vitest";
import {
  article,
  cleanDescriptor,
  cleanGenre,
  factPool,
  KnownArtists,
  type ColourFact,
  type ColourFactKind,
} from "../src/facts.ts";
import type { QueueEntry } from "../src/queue.ts";
import type { Artist, Gig } from "../src/types.ts";
import { entry, gig, NOW, track } from "./helpers.ts";

type MusicBrainzDetails = NonNullable<Artist["musicbrainz"]>;

function artist(mb: Partial<MusicBrainzDetails> | null, extra: Partial<Artist> = {}): Artist {
  return {
    name: "Mogwai",
    musicbrainz: mb && {
      type: "Group",
      country: null,
      area: null,
      begin_area: null,
      begin: null,
      ended: false,
      genres: [],
      tags: [],
      ...mb,
    },
    lastfm: null,
    wikipedia: null,
    ...extra,
  };
}

function withArtist(a: Artist | undefined, gigOverrides: Partial<Gig> = {}, extra: Partial<QueueEntry> = {}): QueueEntry {
  const e = entry("mb:x", "2026-09-27T20:30:00+02:00", { name: "Mogwai", ...extra });
  const out: QueueEntry = { ...e, gig: { ...e.gig, availability: "unknown", price: null, ...gigOverrides } };
  if (a) out.artist = a;
  return out;
}

function pool(e: QueueEntry, known: string[] = [], song: string | null = null): ColourFact[] {
  return factPool({ entry: e, song, now: NOW, knownArtists: new KnownArtists(known) });
}

function find<K extends ColourFactKind>(facts: ColourFact[], kind: K): Extract<ColourFact, { kind: K }> | undefined {
  return facts.find((f) => f.kind === kind) as Extract<ColourFact, { kind: K }> | undefined;
}

describe("cleanGenre", () => {
  it.each(["seen live", "Seen Live", "favorites", "favourites", "female vocalists", "british", "Dutch", "2010", "90s", "under 2000 listeners", "a very very long tag that goes on", "", "Mogwai"])(
    "drops junk: %j",
    (tag) => expect(cleanGenre(tag, "Mogwai")).toBeNull(),
  );

  it("keeps real genres, lower-cased and tidied", () => {
    expect(cleanGenre("Post-Rock")).toBe("post-rock");
    expect(cleanGenre("post rock")).toBe("post-rock");
    expect(cleanGenre("80s synth-pop")).toBe("80s synth-pop");
    expect(cleanGenre("Hip-Hop")).toBe("hip hop");
    expect(cleanGenre("rnb")).toBe("R&B");
    expect(cleanGenre("uk garage")).toBe("uk garage");
    expect(cleanGenre(null)).toBeNull();
  });
});

describe("cleanDescriptor", () => {
  it("uses short, clean Wikipedia descriptions", () => {
    expect(cleanDescriptor("Scottish post-rock band")).toBe("a Scottish post-rock band");
    expect(cleanDescriptor("American singer-songwriter")).toBe("an American singer-songwriter");
    expect(cleanDescriptor("Electronic music duo")).toBe("an electronic music duo");
  });

  it("skips the rest", () => {
    for (const d of [null, "", "Wikimedia disambiguation page", "British musician (born 1971)", "Canadian singer, songwriter and actress", "Town in Norway", "x".repeat(60)]) {
      expect(cleanDescriptor(d)).toBeNull();
    }
  });
});

describe("article", () => {
  it("picks a or an by sound", () => {
    expect(article("indie band")).toBe("an");
    expect(article("post-rock band")).toBe("a");
    expect(article("80s synth-pop act")).toBe("an");
    expect(article("R&B artist")).toBe("an");
    expect(article("uk garage act")).toBe("a");
  });
});

describe("factPool", () => {
  it("has nothing but gig-based facts without an artist record", () => {
    expect(pool(withArtist(undefined))).toEqual([]);
    expect(pool(withArtist(artist(null)))).toEqual([]);
  });

  it("says where they're from: town, region or country", () => {
    const glasgow = find(pool(withArtist(artist({ country: "GB", area: "Scotland", begin_area: "Glasgow" }))), "origin");
    expect(glasgow).toMatchObject({ place: "Glasgow", demonym: "Scottish", local: false, noun: "band" });
    const norway = find(pool(withArtist(artist({ country: "NO", area: "Norway", type: "Person" }))), "origin");
    expect(norway).toMatchObject({ place: null, demonym: "Norwegian", noun: "artist" });
    expect(find(pool(withArtist(artist({ area: "Worldwide", country: "XW" }))), "origin")).toBeUndefined();
    expect(find(pool(withArtist(artist({ area: "Amsterdam", country: "NL" }))), "origin")).toMatchObject({ local: true, demonym: "Dutch" });
  });

  it("says when a group formed, but never a person's birth year", () => {
    expect(find(pool(withArtist(artist({ begin: "1995-04-01" }))), "formed")).toMatchObject({ year: 1995, recent: false, founded: false });
    expect(find(pool(withArtist(artist({ begin: "2025" }))), "formed")).toMatchObject({ recent: true });
    expect(find(pool(withArtist(artist({ begin: "1888", type: "Orchestra" }))), "formed")).toMatchObject({ founded: true });
    for (const mb of [{ begin: "1971", type: "Person" }, { begin: "1971", type: null }, { begin: "1990", ended: true }, { begin: "2031" }, { begin: "soon" }, { begin: null }]) {
      expect(find(pool(withArtist(artist(mb))), "formed")).toBeUndefined();
    }
  });

  it("finds a short genre from MusicBrainz, Last.fm or Wikipedia", () => {
    const a = artist({ genres: [] }, { lastfm: { tags: ["seen live", "Shoegaze", "dream pop"], similar: [] } });
    expect(find(pool(withArtist(a)), "genre")).toMatchObject({ genres: ["shoegaze", "dream pop"] });
    const wiki = artist(null, { wikipedia: { description: "Scottish post-rock band" } });
    expect(find(pool(withArtist(wiki)), "genre")).toMatchObject({ genres: [], descriptor: "a Scottish post-rock band" });
  });

  it("only says 'if you like' for artists the listener knows", () => {
    const a = artist(null, { lastfm: { tags: [], similar: ["Mogwai", "Explosions in the Sky", "The Slowdive"] } });
    expect(find(pool(withArtist(a)), "similar")).toBeUndefined();
    expect(find(pool(withArtist(a), ["Mogwai"]), "similar")).toBeUndefined(); // never themselves
    expect(find(pool(withArtist(a), ["slowdive", "Mogwai"]), "similar")).toMatchObject({ like: "The Slowdive" });
  });

  it("knows who they play with", () => {
    const g = gig({
      artists: [
        { key: "mb:head", name: "Big Band", role: "headliner" },
        { key: "mb:s1", name: "Small Band", role: "support" },
        { key: "mb:s2", name: "Tiny Band", role: "support" },
      ],
    });
    const head: QueueEntry = { artistKey: "mb:head", name: "Big Band", role: "headliner", gig: g, tracks: [track("h")] };
    const sup: QueueEntry = { artistKey: "mb:s1", name: "Small Band", role: "support", gig: g, tracks: [track("s")] };
    expect(find(pool(head), "support")).toMatchObject({ supporting: null, supportedBy: ["Small Band", "Tiny Band"] });
    expect(find(pool(sup), "support")).toMatchObject({ supporting: "Big Band", supportedBy: [] });
    expect(find(pool(withArtist(undefined)), "support")).toBeUndefined();
  });

  it("only has ticket news worth saying", () => {
    const news = (g: Partial<Gig>) => find(pool(withArtist(undefined, g)), "ticket");
    expect(news({ availability: "sold_out" })).toMatchObject({ news: "sold_out" });
    expect(news({ availability: "few_left" })).toMatchObject({ news: "few_left" });
    expect(news({ availability: "free" })).toMatchObject({ news: "free" });
    expect(news({ price: { min_eur: 0, max_eur: 0 } })).toMatchObject({ news: "free" });
    expect(news({ status: "postponed", availability: "sold_out" })).toMatchObject({ news: "postponed" });
    expect(news({ price: { min_eur: 23.5, max_eur: 30 } })).toMatchObject({ news: "price", price: "about 24 euros", range: true });
    expect(news({ price: { min_eur: 23.5, max_eur: 30 } })!.weight).toBeLessThan(news({ availability: "sold_out" })!.weight);
    expect(news({})).toBeUndefined();
    expect(news({ availability: "on_sale", price: { min_eur: null, max_eur: null } })).toBeUndefined();
  });

  it("offers the song when there's a title to say", () => {
    expect(find(pool(withArtist(undefined), [], "Tidewater"), "track")).toMatchObject({ song: "Tidewater" });
  });
});
