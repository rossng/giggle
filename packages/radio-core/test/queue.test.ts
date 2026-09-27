import { describe, expect, it } from "vitest";
import { buildQueue, isUpcoming, pickTracks } from "../src/queue.ts";
import type { Artist, Track } from "../src/types.ts";
import { gig, inDays, keys, NOW, SAMPLE, track } from "./helpers.ts";

const A = { key: "mb:a", name: "Alpha", role: "headliner" as const };
const B = { key: "mb:b", name: "Bravo", role: "support" as const };
const C = { key: "name:charlie", name: "Charlie", role: "headliner" as const };

const tracksFor = (...ids: string[]): Record<string, Track[]> =>
  Object.fromEntries(ids.map((k) => [k, [track(`${k}-1`), track(`${k}-2`), track(`${k}-3`)]]));

describe("isUpcoming", () => {
  it("keeps gigs until they end, or four hours after the start", () => {
    const g = gig({ start: "2026-09-26T09:00:00+02:00" });
    expect(isUpcoming(g, NOW)).toBe(true); // started 3h ago
    expect(isUpcoming(g, new Date("2026-09-26T13:30:00+02:00"))).toBe(false);
    const long = gig({ start: "2026-09-26T09:00:00+02:00", end: "2026-09-26T23:00:00+02:00" });
    expect(isUpcoming(long, new Date("2026-09-26T22:00:00+02:00"))).toBe(true);
  });

  it("drops cancelled gigs and unparseable dates", () => {
    expect(isUpcoming(gig({ status: "cancelled" }), NOW)).toBe(false);
    expect(isUpcoming(gig({ status: "postponed" }), NOW)).toBe(true);
    expect(isUpcoming(gig({ start: "someday" }), NOW)).toBe(false);
  });
});

describe("pickTracks", () => {
  it("takes the first n distinct, playable tracks", () => {
    const ts = [track("x"), track("x"), { videoId: "", title: "?" }, track("y"), track("z")];
    expect(pickTracks(ts, 2).map((t) => t.videoId)).toEqual(["x", "y"]);
    expect(pickTracks(ts, 10).map((t) => t.videoId)).toEqual(["x", "y", "z"]);
  });
});

describe("buildQueue", () => {
  it("makes one entry per artist at their earliest upcoming gig", () => {
    const later = gig({ id: "v:later", start: inDays(5), artists: [A] });
    const sooner = gig({ id: "v:sooner", start: inDays(1), artists: [C, A] });
    const { entries } = buildQueue({ gigs: [later, sooner], tracks: tracksFor("mb:a", "name:charlie"), now: NOW });
    expect(keys(entries)).toEqual(["name:charlie", "mb:a"]);
    expect(entries[1]?.gig.id).toBe("v:sooner");
  });

  it("ignores gigs that are over or cancelled when choosing the earliest", () => {
    const past = gig({ id: "v:past", start: inDays(-1), artists: [A] });
    const cancelled = gig({ id: "v:cancelled", start: inDays(1), status: "cancelled", artists: [A] });
    const next = gig({ id: "v:next", start: inDays(3), artists: [A] });
    const { entries } = buildQueue({ gigs: [past, cancelled, next], tracks: tracksFor("mb:a"), now: NOW });
    expect(entries.map((e) => e.gig.id)).toEqual(["v:next"]);
  });

  it("takes N tracks per artist (default 2)", () => {
    const g = gig({ artists: [A] });
    expect(buildQueue({ gigs: [g], tracks: tracksFor("mb:a"), now: NOW }).entries[0]?.tracks).toHaveLength(2);
    const three = buildQueue({ gigs: [g], tracks: tracksFor("mb:a"), now: NOW, tracksPerArtist: 3 });
    expect(three.entries[0]?.tracks.map((t) => t.videoId)).toEqual(["mb:a-1", "mb:a-2", "mb:a-3"]);
    const zero = buildQueue({ gigs: [g], tracks: tracksFor("mb:a"), now: NOW, tracksPerArtist: 0 });
    expect(zero.entries[0]?.tracks).toHaveLength(1);
  });

  it("skips artists without tracks and reports them", () => {
    const g = gig({ artists: [A, B] });
    const built = buildQueue({ gigs: [g], tracks: { "mb:a": [track("1")], "mb:b": [] }, now: NOW });
    expect(keys(built.entries)).toEqual(["mb:a"]);
    expect(built.withoutTracks).toEqual(["mb:b"]);
  });

  it("skips artists marked not for me and reports them", () => {
    const g = gig({ artists: [A, B] });
    const built = buildQueue({ gigs: [g], tracks: tracksFor("mb:a", "mb:b"), now: NOW, notForMe: ["mb:a"] });
    expect(keys(built.entries)).toEqual(["mb:b"]);
    expect(built.notForMe).toEqual(["mb:a"]);
    expect(built.withoutTracks).toEqual([]);
  });

  it("accepts a Map, a record or a function as the track lookup", () => {
    const g = gig({ artists: [A] });
    const ts = [track("1")];
    for (const lookup of [new Map([["mb:a", ts]]), { "mb:a": ts }, (k: string) => (k === "mb:a" ? ts : undefined)]) {
      expect(keys(buildQueue({ gigs: [g], tracks: lookup, now: NOW }).entries)).toEqual(["mb:a"]);
    }
  });

  it("doesn't pick up inherited object properties as tracks", () => {
    const g = gig({ artists: [{ key: "constructor", name: "Constructor", role: "headliner" }] });
    expect(buildQueue({ gigs: [g], tracks: {}, now: NOW }).entries).toEqual([]);
  });

  it("keeps billing order within a gig and date order across gigs", () => {
    const g1 = gig({ id: "v:1", start: inDays(2), artists: [A, B] });
    const g2 = gig({ id: "v:2", start: inDays(1), artists: [C] });
    const { entries } = buildQueue({ gigs: [g1, g2], tracks: tracksFor("mb:a", "mb:b", "name:charlie"), now: NOW });
    expect(keys(entries)).toEqual(["name:charlie", "mb:a", "mb:b"]);
    expect(entries.map((e) => e.role)).toEqual(["headliner", "headliner", "support"]);
  });

  it("prefers the artists.json name", () => {
    const artist: Artist = { name: "ALPHA (official)", musicbrainz: null, lastfm: null, wikipedia: null };
    const { entries } = buildQueue({
      gigs: [gig({ artists: [A] })],
      tracks: tracksFor("mb:a"),
      now: NOW,
      artists: { "mb:a": artist },
    });
    expect(entries[0]?.name).toBe("ALPHA (official)");
    expect(entries[0]?.artist).toBe(artist);
  });

  it("doesn't mutate its inputs", () => {
    const gigs = [gig({ id: "v:2", start: inDays(2), artists: [A] }), gig({ id: "v:1", start: inDays(1), artists: [C] })];
    const copy = structuredClone(gigs);
    buildQueue({ gigs, tracks: tracksFor("mb:a", "name:charlie"), now: NOW });
    expect(gigs).toEqual(copy);
  });

  it("builds a sensible queue from the sample data", () => {
    const tracks = (key: string) => (key.length % 3 === 0 ? undefined : [track(`${key}#1`, "One"), track(`${key}#2`, "Two")]);
    const { entries, withoutTracks } = buildQueue({ gigs: SAMPLE.gigs, tracks, now: NOW });
    const all = new Set(SAMPLE.gigs.flatMap((g) => g.artists.map((a) => a.key)));
    expect(entries.length).toBeGreaterThan(20);
    expect(new Set(keys(entries)).size).toBe(entries.length);
    expect(entries.length + withoutTracks.length).toBeLessThanOrEqual(all.size);
    for (let i = 1; i < entries.length; i++) {
      expect(Date.parse(entries[i]!.gig.start)).toBeGreaterThanOrEqual(Date.parse(entries[i - 1]!.gig.start));
    }
    for (const e of entries) expect(e.gig.artists.some((a) => a.key === e.artistKey)).toBe(true);
  });
});
