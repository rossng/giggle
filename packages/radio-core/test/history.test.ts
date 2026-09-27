import { describe, expect, it } from "vitest";
import {
  daysSinceHeard,
  emptyHistory,
  HISTORY_MAX_PLAYS_PER_ARTIST,
  lastHeard,
  mergeHistory,
  parseHistory,
  pruneHistory,
  recordPlay,
} from "../src/history.ts";
import { DAY_MS } from "../src/time.ts";
import { NOW } from "./helpers.ts";

const t = NOW.getTime();

describe("recordPlay", () => {
  it("adds a timestamp without mutating the input", () => {
    const h0 = emptyHistory();
    const h1 = recordPlay(h0, "mb:a", NOW);
    expect(h0).toEqual({});
    expect(h1).toEqual({ "mb:a": [t] });
    const h2 = recordPlay(h1, "mb:a", new Date(t + 1000));
    expect(h2["mb:a"]).toEqual([t, t + 1000]);
    expect(h1["mb:a"]).toEqual([t]);
  });

  it("drops that artist's plays older than 60 days", () => {
    const h = recordPlay({ "mb:a": [t - 61 * DAY_MS, t - 59 * DAY_MS] }, "mb:a", NOW);
    expect(h["mb:a"]).toEqual([t - 59 * DAY_MS, t]);
  });

  it("keeps at most a fixed number of plays per artist", () => {
    let h = emptyHistory();
    for (let i = 0; i < 50; i++) h = recordPlay(h, "mb:a", new Date(t + i * 1000));
    expect(h["mb:a"]).toHaveLength(HISTORY_MAX_PLAYS_PER_ARTIST);
    expect(h["mb:a"]?.at(-1)).toBe(t + 49_000);
  });

  it("is JSON-serialisable", () => {
    const h = recordPlay(recordPlay({}, "a", NOW), "b", NOW);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});

describe("pruneHistory", () => {
  it("removes old plays and empty artists", () => {
    const h = pruneHistory(
      { old: [t - 90 * DAY_MS], mixed: [t - 70 * DAY_MS, t - DAY_MS], fresh: [t] },
      NOW,
    );
    expect(h).toEqual({ mixed: [t - DAY_MS], fresh: [t] });
  });

  it("takes a custom age", () => {
    expect(pruneHistory({ a: [t - 8 * DAY_MS, t - 2 * DAY_MS] }, NOW, 7)).toEqual({ a: [t - 2 * DAY_MS] });
  });
});

describe("lastHeard / daysSinceHeard", () => {
  const h = { a: [t - 5 * DAY_MS, t - 2 * DAY_MS], b: [] };
  it("finds the most recent play", () => {
    expect(lastHeard(h, "a")).toBe(t - 2 * DAY_MS);
    expect(lastHeard(h, "b")).toBeUndefined();
    expect(lastHeard(h, "c")).toBeUndefined();
    expect(lastHeard(undefined, "a")).toBeUndefined();
  });

  it("counts days, never negative", () => {
    expect(daysSinceHeard(h, "a", NOW)).toBeCloseTo(2);
    expect(daysSinceHeard({ a: [t + DAY_MS] }, "a", NOW)).toBe(0);
    expect(daysSinceHeard(h, "c", NOW)).toBeUndefined();
  });
});

describe("parseHistory", () => {
  it("keeps valid entries and drops junk", () => {
    expect(parseHistory({ a: [3, 1, "x", null, Number.NaN], b: "nope", c: [] })).toEqual({ a: [1, 3] });
    expect(parseHistory(null)).toEqual({});
    expect(parseHistory([1, 2])).toEqual({});
    expect(parseHistory("{}")).toEqual({});
  });
});

describe("mergeHistory", () => {
  it("unites two devices' plays, each play once, oldest first", () => {
    const a = { "mb:a": [t - 3000, t - 1000], "mb:b": [t - 500] };
    const b = { "mb:a": [t - 2000, t - 1000], "mb:c": [t] };
    const merged = mergeHistory(a, b, NOW);
    expect(merged).toEqual({
      "mb:a": [t - 3000, t - 2000, t - 1000],
      "mb:b": [t - 500],
      "mb:c": [t],
    });
    expect(mergeHistory(b, a, NOW)).toEqual(merged);
    expect(a["mb:a"]).toEqual([t - 3000, t - 1000]);
  });

  it("prunes the result like pruneHistory: old plays and the per-artist limit", () => {
    const n = HISTORY_MAX_PLAYS_PER_ARTIST;
    const odd = Array.from({ length: n }, (_, i) => t - 2 * i - 1);
    const even = Array.from({ length: n }, (_, i) => t - 2 * i);
    const local = { "mb:a": odd, "mb:old": [t - 61 * DAY_MS] };
    const merged = mergeHistory(local, { "mb:a": even }, NOW);
    expect(merged["mb:a"]).toHaveLength(n);
    expect(merged["mb:a"]!.at(-1)).toBe(t);
    expect(merged["mb:old"]).toBeUndefined();
  });
});
