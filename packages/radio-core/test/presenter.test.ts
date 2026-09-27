import { describe, expect, it } from "vitest";
import { spokenWhere, tidy } from "../src/announcer.ts";
import { COLOUR_FACT_KINDS, type FactKind } from "../src/facts.ts";
import { DEFAULT_BUDGETS, Presenter, type Line, type PresenterOptions } from "../src/presenter.ts";
import { buildQueue, type QueueEntry } from "../src/queue.ts";
import { mulberry32 } from "../src/random.ts";
import { parseSaid } from "../src/said.ts";
import { estimateSeconds } from "../src/speech.ts";
import { planSegment } from "../src/timing.ts";
import type { Artist, Gig, Venue } from "../src/types.ts";
import { BOARD, syntheticArtist } from "./artists.ts";
import { entry, gig, NOW, SAMPLE, track } from "./helpers.ts";

const VENUES: Record<string, Venue> = {
  paradiso: { name: "Paradiso", city: "Amsterdam" },
  patronaat: { name: "Patronaat", city: "Haarlem" },
  leidsegroot: { name: "Groot Leiden Hall", city: "Leiden" },
};

function presenter(seed = 1, options: Partial<PresenterOptions> = {}): Presenter {
  return new Presenter({ rng: mulberry32(seed), venues: VENUES, ...options });
}

const RICH: Artist = {
  name: "Mogwai",
  musicbrainz: {
    type: "Group",
    country: "GB",
    area: "Scotland",
    begin_area: "Glasgow",
    begin: "1995",
    ended: false,
    genres: ["post-rock"],
    tags: [],
  },
  lastfm: { tags: ["seen live", "instrumental"], similar: ["Slowdive"] },
  wikipedia: null,
};

/** Mogwai at Paradiso, sold out, supported by Small Band, with a song title. */
function rich(overrides: Partial<Gig> = {}): QueueEntry {
  const g = gig({
    id: "gig:mogwai",
    start: "2026-10-16T20:30:00+02:00",
    availability: "sold_out",
    artists: [
      { key: "mb:mogwai", name: "Mogwai", role: "headliner" },
      { key: "mb:small", name: "Small Band", role: "support" },
    ],
    ...overrides,
  });
  return { artistKey: "mb:mogwai", name: "Mogwai", role: "headliner", gig: g, tracks: [track("t1", "Tidewater (Official Video)"), track("t2", "Hunted by a Freak")], artist: RICH };
}

/** Mike: no artist record, nothing notable about the gig, no usable titles. */
function bare(): QueueEntry {
  const e = entry("name:mike", "2026-09-26T20:30:00+02:00", { name: "Mike", tracks: [track("m1", ""), track("m2", "")] });
  return { ...e, gig: { ...e.gig, availability: "unknown", price: null } };
}

function expectClean(text: string): void {
  expect(text).not.toMatch(/undefined|null|NaN|\[object|€/);
  expect(text).not.toMatch(/\d[.,]\d+\s*euro/);
  expect(text).not.toMatch(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/);
  expect(text).not.toMatch(/\s{2,}|\s[.,:]|\.\.|,,|^\s|\s$/);
  expect(text).toMatch(/[.!?]$/);
}

const COLOUR = new Set<FactKind>(COLOUR_FACT_KINDS);
const colourOf = (line: Line) => line.facts.filter((f) => COLOUR.has(f));

describe("Presenter.intro", () => {
  it("is just the gig line when there's nothing else to say", () => {
    const p = presenter(1, { probabilities: { colour: 1 } });
    for (let i = 0; i < 30; i++) {
      const line = p.intro(bare(), "short", NOW);
      expect(line.facts).toEqual(["gig"]);
      expect(line.text).toMatch(/Mike/);
      expect(line.text).toMatch(/Paradiso/);
      expect(line.text).toMatch(/tonight/i);
      expectClean(line.text);
    }
  });

  it("adds at most one colour fact to the gig", () => {
    const p = presenter(2, { knownArtists: BOARD });
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const line = p.intro(rich(), "short", NOW);
      expect(line.facts[0]).toBe("gig");
      expect(colourOf(line).length).toBeLessThanOrEqual(1);
      expect(line.text).toMatch(/Mogwai/);
      expect(line.text).toMatch(/Paradiso/);
      expect(line.text).toMatch(/sixteenth of October/);
      expectClean(line.text);
      colourOf(line).forEach((k) => seen.add(k));
    }
    // Every kind turns up sometimes: origin, formed, genre, similar, support, ticket, track.
    expect([...seen].sort()).toEqual(["formed", "genre", "origin", "similar", "support", "ticket", "track"]);
  });

  it("phrases each fact the way a presenter would", () => {
    const p = presenter(3, { knownArtists: ["Slowdive"], probabilities: { colour: 1 } });
    const texts = Array.from({ length: 300 }, () => p.intro(rich(), "short", NOW).text).join("\n");
    expect(texts).toMatch(/from Glasgow|Scottish band/);
    expect(texts).toMatch(/together since 1995|formed back in 1995|got together in 1995/);
    expect(texts).toMatch(/post-rock/);
    expect(texts).toMatch(/If you like Slowdive|fans of Slowdive|Slowdive fans/i);
    expect(texts).toMatch(/Small Band/);
    expect(texts).toMatch(/sold out|Tickets are gone/i);
    expect(texts).toMatch(/Tidewater/);
    expect(texts).not.toMatch(/Official|seen live|instrumental/i);
  });

  it("never says 'formed' or a year for a person", () => {
    const person: Artist = { ...RICH, musicbrainz: { ...RICH.musicbrainz!, type: "Person", begin: "1971-02-03" } };
    const p = presenter(4, { probabilities: { colour: 1 } });
    for (let i = 0; i < 100; i++) {
      const text = p.intro({ ...rich(), artist: person }, "short", NOW).text;
      expect(text).not.toMatch(/formed|together since|1971|founded/);
    }
  });

  it("only says 'if you like' for artists the listener knows", () => {
    const p = presenter(5, { probabilities: { colour: 1 } });
    for (let i = 0; i < 100; i++) expect(p.intro(rich(), "short", NOW).facts).not.toContain("similar");
    p.setKnownArtists(["slowdive"]);
    const facts = Array.from({ length: 100 }, () => p.intro(rich(), "short", NOW).facts).flat();
    expect(facts).toContain("similar");
  });

  it("rotates through facts on repeat plays, never the same kind twice running", () => {
    const p = presenter(6, { knownArtists: BOARD, probabilities: { colour: 1 } });
    const kinds: FactKind[] = [];
    for (let i = 0; i < 7; i++) kinds.push(...colourOf(p.intro(rich(), "short", new Date(NOW.getTime() + i * 3_600_000))));
    // Seven plays, seven different facts: each one said before any is repeated.
    expect(new Set(kinds).size).toBe(7);
    for (let i = 0; i < 30; i++) {
      kinds.push(...colourOf(p.intro(rich(), "short", NOW)));
      expect(kinds.at(-1)).not.toBe(kinds.at(-2));
    }
  });

  it("remembers what was said across sessions via the serialised memory", () => {
    const first = presenter(7, { probabilities: { colour: 1 } });
    const said = Array.from({ length: 3 }, () => colourOf(first.intro(rich(), "short", NOW))).flat();
    expect(said).toHaveLength(3);
    const stored = JSON.parse(JSON.stringify(first.said));
    const second = presenter(8, { probabilities: { colour: 1 }, said: parseSaid(stored) });
    const next = colourOf(second.intro(rich(), "short", NOW));
    expect(said).not.toContain(next[0]);
  });

  it("in name mode says only who, where and when, briefly", () => {
    const p = presenter(9, { knownArtists: BOARD });
    for (let i = 0; i < 40; i++) {
      const line = p.intro(rich({ availability: "on_sale" }), "name", NOW);
      expect(line.facts).toEqual(["gig"]);
      expect(line.mode).toBe("name");
      expect(line.text).toMatch(/^Mogwai[.,:]/);
      expect(line.text).not.toMatch(/Glasgow|post-rock|Slowdive|Small Band|euro|Tidewater/);
      expect(line.seconds).toBeLessThanOrEqual(DEFAULT_BUDGETS.nameCap);
      expect(planSegment({ line, voice: "name" }).mode).toBe("overIntro");
    }
  });

  it("reports the estimated length", () => {
    const p = presenter(10);
    const line = p.intro(rich(), "short", NOW);
    expect(line.seconds).toBe(estimateSeconds(line.text));
    const slow = presenter(10, { speech: { rate: 0.5 } }).intro(rich(), "short", NOW);
    expect(slow.seconds).toBe(estimateSeconds(slow.text, { rate: 0.5 }));
  });

  it("drops the colour fact, then the start time, to stay under the cap", () => {
    const p = presenter(11, { knownArtists: BOARD, probabilities: { colour: 1, time: 1 }, budgets: { introMin: 1, introMax: 4, introCap: 4.5 } });
    for (let i = 0; i < 50; i++) {
      const line = p.intro(rich({ start: "2026-09-26T20:30:00+02:00" }), "short", NOW);
      expect(line.seconds).toBeLessThanOrEqual(4.5);
      expect(line.text).not.toMatch(/8\.30pm/);
      expect(line.text).toMatch(/Mogwai/);
      expect(line.text).toMatch(/Paradiso/);
    }
  });

  it("shortens a far-off date before giving up", () => {
    const p = presenter(12, { budgets: { introMin: 1, introMax: 3, introCap: 3.4 } });
    const texts = Array.from({ length: 20 }, () => p.intro(rich(), "short", NOW).text);
    expect(texts.some((t) => /on the sixteenth of October/.test(t))).toBe(true);
  });

  it("never repeats a wording twice in a row", () => {
    const p = presenter(13, { probabilities: { colour: 0 } });
    const texts = Array.from({ length: 50 }, () => p.intro(bare(), "short", NOW).text);
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
  });

  it("opens a quick intro with a short naming, keeping the facts, their rotation and the budget", () => {
    const opening = /^(Here's|This is|On now,) Mogwai\. /;
    const p = presenter(14, { knownArtists: BOARD, probabilities: { colour: 1 } });
    const kinds: FactKind[] = [];
    for (let i = 0; i < 7; i++) {
      const line = p.intro(rich(), "short", new Date(NOW.getTime() + i * 3_600_000), 0, { quick: true });
      expect(line.text).toMatch(opening);
      expect(line.text).toMatch(/Paradiso/);
      expect(line.seconds).toBeLessThanOrEqual(DEFAULT_BUDGETS.introCap);
      expect(colourOf(line).length).toBe(1);
      expectClean(line.text);
      kinds.push(...colourOf(line));
    }
    // Every fact still gets its turn, ticket news included (after the gig line).
    expect(new Set(kinds).size).toBe(7);
    const bareLine = p.forTrack({ entry: bare(), trackIndex: 0, mode: "short", now: NOW, quick: true })!;
    expect(bareLine.text).toMatch(/^(Here's|This is|On now,) Mike\. .*Paradiso/);
    // Only when asked: most intros open some other way.
    const usual = Array.from({ length: 50 }, () => p.intro(rich(), "short", NOW).text);
    expect(usual.filter((t) => opening.test(t)).length).toBeLessThan(40);
    // Name mode and clip intros already open briefly.
    expect(p.forTrack({ entry: rich(), trackIndex: 0, mode: "name", now: NOW, quick: true })!.text).toMatch(/^Mogwai[.,:]/);
  });

  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const p = presenter(seed, { knownArtists: BOARD });
      return Array.from({ length: 20 }, () => p.intro(rich(), "short", NOW).text);
    };
    expect(run(21)).toEqual(run(21));
    expect(run(21)).not.toEqual(run(22));
  });
});

describe("Presenter.micro and backAnnounce", () => {
  it("keeps micro-announcements under 3 seconds, even with long titles", () => {
    const p = presenter(1, { probabilities: { micro: 1 } });
    const long = rich();
    long.tracks = [track("a"), track("b", "An Extraordinarily Long Song Title That Goes On For Ages")];
    for (let i = 0; i < 50; i++) {
      const line = p.micro(long, 1)!;
      expect(line.kind).toBe("micro");
      expect(line.seconds).toBeLessThanOrEqual(3);
      expect(line.text).toMatch(/Mogwai/);
      expectClean(line.text);
    }
    expect(p.micro(long, 0)).toBeNull();
    expect(presenter(1, { probabilities: { micro: 0 } }).micro(long, 1)).toBeNull();
  });

  it("back-announces a track whose title wasn't said going in", () => {
    const p = presenter(2, { probabilities: { back: 1 } });
    const line = p.backAnnounce(rich(), 1)!;
    expect(line.kind).toBe("back");
    expect(line.text).toMatch(/Mogwai/);
    expect(line.text).toMatch(/Hunted by a Freak/);
    expect(line.seconds).toBeLessThanOrEqual(6);
    expect(presenter(2, { probabilities: { back: 0 } }).backAnnounce(rich(), 1)).toBeNull();
  });

  it("doesn't back-announce a song it named on the way in", () => {
    const p = presenter(3, { probabilities: { back: 1, micro: 1 } });
    for (let i = 0; i < 30; i++) {
      const e = rich();
      const micro = p.micro(e, 1)!;
      const back = p.backAnnounce(e, 1);
      if (micro.text.includes("Hunted by a Freak")) expect(back).toBeNull();
    }
  });

  it("forTrack picks an intro or a micro-announcement", () => {
    const p = presenter(4, { probabilities: { micro: 1 } });
    const e = rich();
    expect(p.forTrack({ entry: e, trackIndex: 0, mode: "off", now: NOW })).toBeNull();
    expect(p.forTrack({ entry: e, trackIndex: 0, mode: "short", now: NOW })!.kind).toBe("intro");
    const same = { entry: e, trackIndex: 1, now: NOW, announcedArtistKey: e.artistKey };
    expect(p.forTrack({ ...same, mode: "short" })!.kind).toBe("micro");
    expect(p.forTrack({ ...same, mode: "name" })).toBeNull();
  });
});

describe("presenter output over the sample data", () => {
  const titles = ["Tidewater (feat. X) [Official Video]", "Song Two - Remastered 2011", "Mike - Something (Live at Paradiso)", "“Quoted”", "Plain", "A Very Long Song Title Indeed, With Many Many Words In It"];
  const artists: Record<string, Artist> = {};
  for (const g of SAMPLE.gigs) for (const a of g.artists) artists[a.key] = syntheticArtist(a.key, a.name, 7);
  const { entries } = buildQueue({
    gigs: SAMPLE.gigs,
    tracks: (key) => titles.map((t, i) => track(`${key}#${i}`, t)).slice(key.length % 4, (key.length % 4) + 3),
    now: NOW,
    tracksPerArtist: 3,
    artists,
  });

  it("has artist records with facts to say", () => {
    expect(entries.filter((e) => e.artist).length).toBe(entries.length);
    const p = presenter(1, { venues: SAMPLE.venues, knownArtists: BOARD });
    const kinds = new Set(entries.flatMap((e) => p.facts(e, 0, NOW).map((f) => f.kind)));
    expect([...kinds].sort()).toEqual([...COLOUR_FACT_KINDS].sort());
  });

  it.each([1, 2, 3, 4])("respects the length budgets and stays clean (seed %i)", (seed) => {
    const p = new Presenter({
      rng: mulberry32(seed),
      venues: SAMPLE.venues,
      knownArtists: BOARD,
      probabilities: { micro: 1, back: 1 },
    });
    const days = [0, 1, 3, 8, 20].map((d) => new Date(NOW.getTime() - d * 86_400_000));
    const counts = { intro: 0, micro: 0, back: 0, inTarget: 0, short: 0 };
    for (const now of days) {
      for (const e of entries) {
        for (const mode of ["name", "short"] as const) {
          const line = p.intro(e, mode, now);
          expectClean(line.text);
          expect(line.text).toContain(e.name.trim());
          expect(line.seconds).toBeLessThanOrEqual(mode === "name" ? DEFAULT_BUDGETS.nameCap : DEFAULT_BUDGETS.introCap);
          counts.intro++;
          if (mode === "short") {
            counts.short++;
            if (line.seconds >= 5 && line.seconds <= 9) counts.inTarget++;
          }
        }
        const quick = p.intro(e, "short", now, 0, { quick: true });
        expectClean(quick.text);
        expect(quick.text.split(/(?<=[.!?])\s/)[0]).toContain(e.name.trim());
        expect(quick.seconds).toBeLessThanOrEqual(DEFAULT_BUDGETS.introCap);
        for (let i = 1; i < e.tracks.length; i++) {
          const m = p.micro(e, i);
          if (m) {
            expectClean(m.text);
            expect(m.seconds).toBeLessThanOrEqual(DEFAULT_BUDGETS.microCap);
            counts.micro++;
          }
        }
        for (let i = 0; i < e.tracks.length; i++) {
          const b = p.backAnnounce(e, i);
          if (b) {
            expectClean(b.text);
            expect(b.seconds).toBeLessThanOrEqual(DEFAULT_BUDGETS.backCap);
            counts.back++;
          }
        }
      }
    }
    expect(counts.intro + counts.micro + counts.back).toBeGreaterThan(1000);
    // Most links land in the 5–9 s target; the rest are shorter (little to say).
    expect(counts.inTarget / counts.short).toBeGreaterThan(0.6);
  });
});


describe("spokenWhere", () => {
  it("names the venue, and the city outside the home city", () => {
    expect(spokenWhere(gig({ venue: "paradiso", city: "Amsterdam" }), VENUES, "Amsterdam")).toBe("Paradiso");
    expect(spokenWhere(gig({ venue: "patronaat", city: "Haarlem" }), VENUES, "Amsterdam")).toBe("Patronaat in Haarlem");
    expect(spokenWhere(gig({ venue: "paradiso", city: "Amsterdam" }), VENUES, "Utrecht")).toBe("Paradiso in Amsterdam");
  });

  it("falls back to the venue's city, and doesn't repeat a city in the name", () => {
    expect(spokenWhere(gig({ venue: "patronaat", city: null }), VENUES, "Amsterdam")).toBe("Patronaat in Haarlem");
    expect(spokenWhere(gig({ venue: "leidsegroot", city: "Leiden" }), VENUES, "Amsterdam")).toBe("Groot Leiden Hall");
  });

  it("uses the slug for unknown venues", () => {
    expect(spokenWhere(gig({ venue: "occii", city: "Amsterdam" }), VENUES, "Amsterdam")).toBe("Occii");
    expect(spokenWhere(gig({ venue: "occii", city: null }), VENUES, "Amsterdam")).toBe("Occii");
  });
});

describe("ticket news", () => {
  /** Intros for Mike with only ticket news to add. */
  const intros = (overrides: Partial<Gig>, seed = 3): string[] => {
    const p = presenter(seed, { probabilities: { colour: 1 } });
    return Array.from({ length: 20 }, () => {
      const e = bare();
      return p.intro({ ...e, gig: { ...e.gig, ...overrides } }, "short", NOW).text;
    });
  };

  it.each([
    ["sold_out", /sold out|gone/i],
    ["few_left", /few tickets|nearly gone|almost sold out|running low/i],
    ["free", /free/i],
    ["not_yet_on_sale", /aren't on sale/i],
  ] as const)("covers %s", (availability, pattern) => {
    for (const text of intros({ availability })) expect(text).toMatch(pattern);
  });

  it("treats a zero price as free, and mentions a postponement", () => {
    for (const text of intros({ price: { min_eur: 0, max_eur: 0 } })) expect(text).toMatch(/free/i);
    for (const text of intros({ status: "postponed" })) expect(text).toMatch(/postponed/);
  });

  it("says whole euros, 'from' for a range, and never decimals", () => {
    const texts = [...intros({ price: { min_eur: 17, max_eur: 22 } }), ...intros({ price: { min_eur: 23.5, max_eur: null } }, 4)];
    expect(texts.join("\n")).toMatch(/Tickets (from|start at) 17 euros\./);
    expect(texts.join("\n")).toMatch(/about 24 euros( to get in)?\./);
    for (const text of texts) expectClean(text);
  });
});

describe("tidy", () => {
  it("doesn't double the full stop after names that end in one", () => {
    expect(tidy("This is M.I.K.E.. They play Paradiso tonight.")).toBe("This is M.I.K.E. They play Paradiso tonight.");
    expect(tidy("mike.. Melkweg, tonight.")).toBe("mike. Melkweg, tonight.");
    expect(tidy("Here's Oh Wonder!. They play  Paradiso.")).toBe("Here's Oh Wonder! They play Paradiso.");
    expect(tidy("Nobu. Paradiso, tonight.")).toBe("Nobu. Paradiso, tonight.");
  });
});

describe("clip intros", () => {
  const clip = { url: "/data/voice/abc.mp3", text: "Djavan, a Brazilian singer-songwriter fusing samba with pop.", seconds: 5.5 };

  it("plays the clip, then says only the gig line", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const line = presenter(seed).forTrack({ entry: rich(), trackIndex: 0, mode: "short", now: NOW, clip });
      expect(line?.clip?.url).toBe(clip.url);
      expect(line?.clip?.spoken).toBeTruthy();
      expect(line?.clip?.spoken).not.toContain(rich().name);
      expect(line!.text.startsWith(clip.text)).toBe(true);
      expect(line!.seconds).toBeGreaterThan(clip.seconds);
      expect(line!.seconds).toBeLessThanOrEqual(DEFAULT_BUDGETS.introCap + 0.01);
    }
  });

  it("isn't used in name mode or for the same artist's next track", () => {
    const e = rich();
    expect(presenter().forTrack({ entry: e, trackIndex: 0, mode: "name", now: NOW, clip })?.clip).toBeUndefined();
    const next = presenter().forTrack({ entry: e, trackIndex: 1, mode: "short", now: NOW, clip, announcedArtistKey: e.artistKey });
    expect(next?.clip).toBeUndefined();
  });
});
