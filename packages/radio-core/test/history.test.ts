import { describe, expect, it } from "vitest";
import {
  daysSinceHeard,
  emptyHistory,
  HISTORY_MAX_PLAYS_PER_ARTIST,
  lastHeard,
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
