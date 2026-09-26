import { describe, expect, it } from "vitest";
import { Announcer, type AnnouncerProbabilities } from "../src/announcer.ts";
import { buildQueue, type QueueEntry } from "../src/queue.ts";
import { mulberry32 } from "../src/random.ts";
import type { Gig, Venue } from "../src/types.ts";
import { entry, gig, NOW, SAMPLE, track } from "./helpers.ts";

const VENUES: Record<string, Venue> = {
  paradiso: { slug: "paradiso", name: "Paradiso", city: "Amsterdam", website: "", country: "NL" },
  patronaat: { slug: "patronaat", name: "Patronaat", city: "Haarlem", website: "", country: "NL" },
  tivolivredenburg: { slug: "tivolivredenburg", name: "TivoliVredenburg", city: "Utrecht", website: "", country: "NL" },
  leidsegroot: { slug: "leidsegroot", name: "Groot Leiden Hall", city: "Leiden", website: "", country: "NL" },
};

function announcer(seed = 1, probabilities: Partial<AnnouncerProbabilities> = {}): Announcer {
  return new Announcer({ rng: mulberry32(seed), venues: VENUES, probabilities });
}

const ALWAYS = { micro: 1, price: 1, time: 1, leadWithGig: 0 };
const NEVER = { micro: 0, price: 0, time: 0, leadWithGig: 0 };

function withGig(overrides: Partial<Gig>, extra: Partial<QueueEntry> = {}): QueueEntry {
  const e = entry("mb:mike", "2026-09-26T20:30:00+02:00", { name: "Mike", ...extra });
  return { ...e, gig: { ...e.gig, ...overrides } };
}

/** Nothing a text-to-speech voice would stumble over or that betrays a bug. */
function expectClean(text: string): void {
  expect(text).not.toMatch(/undefined|null|NaN|\[object|€/);
  expect(text).not.toMatch(/\d[.,]\d+\s*euro/); // no decimal prices
  expect(text).not.toMatch(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/); // no dates in figures
  expect(text).not.toMatch(/\s{2,}|\s[.,:]|\.\.|,,|^\s|\s$/);
  expect(text).toMatch(/[.!?]$/);
}

describe("Announcer.where", () => {
  const a = announcer();
  it("names the venue, and the city outside Amsterdam", () => {
    expect(a.where(gig({ venue: "paradiso", city: "Amsterdam" }))).toBe("Paradiso");
    expect(a.where(gig({ venue: "patronaat", city: "Haarlem" }))).toBe("Patronaat in Haarlem");
  });

  it("falls back to the venue's city, and doesn't repeat a city in the name", () => {
    expect(a.where(gig({ venue: "patronaat", city: null }))).toBe("Patronaat in Haarlem");
    expect(a.where(gig({ venue: "leidsegroot", city: "Leiden" }))).toBe("Groot Leiden Hall");
  });

  it("uses the slug for unknown venues", () => {
    expect(a.where(gig({ venue: "occii", city: "Amsterdam" }))).toBe("Occii");
    expect(a.where(gig({ venue: "occii", city: null }))).toBe("Occii");
  });

  it("can have another home city", () => {
    const utrecht = new Announcer({ rng: mulberry32(1), venues: VENUES, homeCity: "Utrecht" });
    expect(utrecht.where(gig({ venue: "paradiso", city: "Amsterdam" }))).toBe("Paradiso in Amsterdam");
    expect(utrecht.where(gig({ venue: "tivolivredenburg", city: "Utrecht" }))).toBe("TivoliVredenburg");
  });
});

describe("Announcer.ticketNote", () => {
  it.each([
    ["sold_out", /sold out|gone/i],
    ["few_left", /few tickets|nearly gone|almost sold out|running low/i],
    ["free", /free/i],
    ["not_yet_on_sale", /aren't on sale/i],
  ] as const)("covers %s", (availability, pattern) => {
    const a = announcer(3, ALWAYS);
    for (let i = 0; i < 10; i++) expect(a.ticketNote(gig({ availability }))).toMatch(pattern);
  });

  it("treats a zero price as free", () => {
    expect(announcer(1, ALWAYS).ticketNote(gig({ availability: "unknown", price: { min_eur: 0, max_eur: 0 } }))).toMatch(/free/i);
  });

  it("says whole-euro prices plainly and rounds the rest", () => {
    const a = announcer(4, ALWAYS);
    for (let i = 0; i < 10; i++) {
      expect(a.ticketNote(gig({ price: { min_eur: 17, max_eur: 17 } }))).toMatch(/\b17 euros( to get in)?\./);
      const rounded = a.ticketNote(gig({ price: { min_eur: 23.5, max_eur: null } }));
      expect(rounded).toMatch(/about 24 euros( to get in)?\./);
      expectClean(rounded);
    }
  });

  it("says 'from' for a price range", () => {
    const a = announcer(5, ALWAYS);
    for (let i = 0; i < 20; i++) {
      expect(a.ticketNote(gig({ price: { min_eur: 17, max_eur: 22 } }))).toMatch(/^Tickets (from|start at) 17 euros\.$/);
    }
  });

  it("doesn't always say the price", () => {
    expect(announcer(1, NEVER).ticketNote(gig({ price: { min_eur: 17, max_eur: 17 } }))).toBe("");
    const a = announcer(6);
    const said = Array.from({ length: 200 }, () => a.ticketNote(gig({ price: { min_eur: 17, max_eur: 17 } }))).filter(Boolean);
    expect(said.length).toBeGreaterThan(90);
    expect(said.length).toBeLessThan(170);
  });

  it("says nothing without a usable price", () => {
    const a = announcer(1, ALWAYS);
    for (const price of [null, { min_eur: null, max_eur: null }, { min_eur: Number.NaN, max_eur: null }, { min_eur: -3, max_eur: null }]) {
      expect(a.ticketNote(gig({ availability: "unknown", price }))).toBe("");
    }
  });

  it("mentions a postponement", () => {
    expect(announcer(1, NEVER).ticketNote(gig({ status: "postponed", availability: "unknown" }))).toMatch(/postponed/);
  });
});

describe("Announcer.artistIntro", () => {
  it("in name mode says who, where and when", () => {
    const a = announcer(2);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const text = a.artistIntro(withGig({}), "name", NOW);
      seen.add(text);
      expect(text).toMatch(/^Mike[.,:]/);
      expect(text).toMatch(/Paradiso/);
      expect(text).toMatch(/tonight/i);
      expect(text).not.toMatch(/euro|ticket/i);
      expectClean(text);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it("in name mode adds 'Sold out.' when it is", () => {
    expect(announcer(1).artistIntro(withGig({ availability: "sold_out" }), "name", NOW)).toMatch(/ Sold out\.$/);
  });

  it("in short mode includes the gig and the other city", () => {
    const e = withGig({ venue: "patronaat", city: "Haarlem", start: "2026-10-16T20:30:00+02:00" });
    const a = announcer(3, { ...NEVER });
    for (let i = 0; i < 30; i++) {
      const text = a.artistIntro(e, "short", NOW);
      expect(text).toMatch(/Patronaat in Haarlem/);
      expect(text).toMatch(/Friday the sixteenth of October/);
      expect(text).toMatch(/Mike/);
      expectClean(text);
    }
  });

  it("adds the start time British-style when asked", () => {
    const a = announcer(4, { ...NEVER, time: 1 });
    const texts = Array.from({ length: 30 }, () => a.artistIntro(withGig({}), "short", NOW));
    expect(texts.some((t) => t.includes(", at 8.30pm."))).toBe(true);
    for (const t of texts) expectClean(t);
  });

  it("leaves out morning and unknown (midnight) times", () => {
    const a = announcer(4, { ...NEVER, time: 1 });
    for (const start of ["2026-10-16T00:00:00+02:00", "2026-10-16T11:00:00+02:00"]) {
      for (let i = 0; i < 20; i++) expect(a.artistIntro(withGig({ start }), "short", NOW)).not.toMatch(/\bat \d/);
    }
  });

  it("can lead with the gig", () => {
    const a = announcer(5, { ...NEVER, leadWithGig: 1 });
    for (let i = 0; i < 10; i++) {
      const text = a.artistIntro(withGig({}), "short", NOW);
      expect(text).toMatch(/Paradiso tonight[:,]|Tonight at Paradiso:/);
      expect(text).toMatch(/Mike\.$/);
    }
  });

  it("mentions the song sometimes, cleaned", () => {
    const e = withGig({}, { tracks: [track("v1", "Mike - Tidewater (feat. Someone) [Official Video]")] });
    const a = announcer(6, NEVER);
    const texts = Array.from({ length: 60 }, () => a.artistIntro(e, "short", NOW));
    expect(texts.some((t) => t.includes("Tidewater"))).toBe(true);
    for (const t of texts) expect(t).not.toMatch(/Official|feat|\[/);
  });

  it("skips very long song titles", () => {
    const e = withGig({}, { tracks: [track("v1", "x".repeat(120))] });
    const a = announcer(6, NEVER);
    for (let i = 0; i < 40; i++) expect(a.artistIntro(e, "short", NOW)).not.toContain("xxx");
  });

  it("mentions who a support act is supporting, sometimes", () => {
    const g = gig({
      artists: [
        { key: "mb:head", name: "Big Band", role: "headliner" },
        { key: "mb:sup", name: "Small Band", role: "support" },
      ],
    });
    const e: QueueEntry = { artistKey: "mb:sup", name: "Small Band", role: "support", gig: g, tracks: [track("s")] };
    const a = announcer(7, NEVER);
    const texts = Array.from({ length: 80 }, () => a.artistIntro(e, "short", NOW));
    expect(texts.some((t) => /(supporting|open for) Big Band/.test(t))).toBe(true);
    // Headliners are never said to be supporting anyone.
    const head: QueueEntry = { ...e, artistKey: "mb:head", name: "Big Band", role: "headliner" };
    for (let i = 0; i < 80; i++) expect(a.artistIntro(head, "short", NOW)).not.toMatch(/supporting|open for/);
  });

  it("never uses the same intro wording twice in a row", () => {
    const a = announcer(8, NEVER);
    let last: number | undefined;
    for (let i = 0; i < 100; i++) {
      a.artistIntro(withGig({}), "short", NOW);
      const now = a.picker.last("intro");
      expect(now).not.toBe(last);
      last = now;
    }
  });

  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const a = announcer(seed);
      return Array.from({ length: 20 }, (_, i) => a.artistIntro(withGig({ availability: i % 2 ? "few_left" : "on_sale" }), "short", NOW));
    };
    expect(run(11)).toEqual(run(11));
    expect(run(11)).not.toEqual(run(12));
  });
});

describe("Announcer.micro", () => {
  const e = withGig({}, { tracks: [track("1", "First"), track("2", "Second Song (Official Video)"), track("3", "Third")] });

  it("speaks for later tracks with probability p", () => {
    expect(announcer(1, { micro: 0 }).micro(e, 1)).toBeNull();
    const a = announcer(1, { micro: 0.5 });
    const said = Array.from({ length: 400 }, () => a.micro(e, 1)).filter(Boolean).length;
    expect(said).toBeGreaterThan(150);
    expect(said).toBeLessThan(250);
  });

  it("never speaks for the first track or a missing one", () => {
    const a = announcer(1, ALWAYS);
    expect(a.micro(e, 0)).toBeNull();
    expect(a.micro(e, 5)).toBeNull();
  });

  it("names the artist, and the song or its position", () => {
    const a = announcer(2, ALWAYS);
    for (let i = 0; i < 60; i++) {
      const text = a.micro(e, 1 + (i % 2))!;
      expect(text).toContain("Mike");
      expect(text).not.toMatch(/Official/);
      expectClean(text);
    }
    const all = new Set(Array.from({ length: 200 }, () => a.micro(e, 1)));
    expect([...all].some((t) => t?.includes("second one"))).toBe(true);
    expect([...all].some((t) => t?.includes("Second Song"))).toBe(true);
  });
});

describe("Announcer.forTrack", () => {
  const e = withGig({});
  it("says nothing when the voice is off", () => {
    expect(announcer(1, ALWAYS).forTrack({ entry: e, trackIndex: 0, mode: "off", now: NOW })).toBeNull();
  });

  it("introduces a new artist, even mid-way through their tracks", () => {
    const a = announcer(1, ALWAYS);
    expect(a.forTrack({ entry: e, trackIndex: 0, mode: "short", now: NOW })).toMatch(/Mike/);
    expect(a.forTrack({ entry: e, trackIndex: 1, mode: "short", now: NOW, announcedArtistKey: "other" })).toMatch(/Paradiso/);
  });

  it("uses micro-announcements for the same artist only in short mode", () => {
    const a = announcer(1, ALWAYS);
    const same = { entry: e, trackIndex: 1, now: NOW, announcedArtistKey: e.artistKey };
    expect(a.forTrack({ ...same, mode: "short" })).toMatch(/Mike/);
    expect(a.forTrack({ ...same, mode: "name" })).toBeNull();
  });
});

describe("announcements over the sample data", () => {
  const titles = [
    "Tidewater (feat. X) [Official Video]",
    "Song Two - Remastered 2011",
    "Mike - Something (Live at Paradiso)",
    "“Quoted”",
    "Plain",
  ];
  const { entries } = buildQueue({
    gigs: SAMPLE.gigs,
    tracks: (key) => titles.map((t, i) => track(`${key}#${i}`, t)).slice(key.length % 3, (key.length % 3) + 3),
    now: NOW,
    tracksPerArtist: 3,
  });

  it("has a varied sample", () => {
    const av = new Set(entries.map((e) => e.gig.availability));
    expect(av.size).toBeGreaterThanOrEqual(4);
    expect(new Set(entries.map((e) => e.gig.city)).size).toBeGreaterThanOrEqual(3);
    expect(entries.some((e) => e.role === "support")).toBe(true);
  });

  it.each([1, 2, 3, 4, 5])("produces clean British English (seed %i)", (seed) => {
    const a = new Announcer({ rng: mulberry32(seed), venues: SAMPLE.venues });
    const days = [0, 1, 3, 8, 20].map((d) => new Date(NOW.getTime() - d * 86_400_000));
    let count = 0;
    for (const now of days) {
      for (const e of entries) {
        for (const mode of ["name", "short"] as const) {
          const intro = a.artistIntro(e, mode, now);
          expectClean(intro);
          expect(intro).toContain(e.name.trim());
          count++;
        }
        for (let i = 1; i < e.tracks.length; i++) {
          const m = a.micro(e, i);
          if (m) {
            expectClean(m);
            count++;
          }
        }
      }
    }
    expect(count).toBeGreaterThan(500);
  });

  it("never says a price with decimals, even when the data has them", () => {
    const decimals = entries.filter((e) => (e.gig.price?.min_eur ?? 0) % 1 !== 0);
    expect(decimals.length).toBeGreaterThan(0);
    const a = new Announcer({ rng: mulberry32(9), venues: SAMPLE.venues, probabilities: { price: 1 } });
    for (const e of decimals) {
      for (let i = 0; i < 5; i++) {
        const text = a.ticketNote({ ...e.gig, availability: "on_sale" });
        expect(text).toMatch(/about \d+ euros?( to get in)?\./);
        expectClean(text);
      }
    }
  });
});
