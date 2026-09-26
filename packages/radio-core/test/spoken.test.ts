import { describe, expect, it } from "vitest";
import { isWholeEuros, ordinalWord, spokenDay, spokenPrice, spokenTime } from "../src/spoken.ts";
import { NOW } from "./helpers.ts";

// NOW is Saturday 26 September 2026, noon in Amsterdam.
describe("spokenDay", () => {
  it.each([
    ["2026-09-26T20:30:00+02:00", "tonight", "tonight"],
    ["2026-09-26T17:00:00+02:00", "tonight", "tonight"],
    ["2026-09-26T14:00:00+02:00", "this afternoon", "this afternoon"],
    ["2026-09-26T11:00:00+02:00", "today", "today"],
    ["2026-09-27T00:30:00+02:00", "tonight", "tonight"],
    ["2026-09-27T15:00:00+02:00", "tomorrow", "tomorrow"],
    ["2026-09-27T20:00:00+02:00", "tomorrow night", "tomorrow night"],
    ["2026-09-28T04:00:00+02:00", "tomorrow night", "tomorrow night"],
    ["2026-09-28T06:00:00+02:00", "on Monday", "Monday"],
    ["2026-09-29T20:00:00+02:00", "on Tuesday", "Tuesday"],
    ["2026-10-02T20:00:00+02:00", "on Friday", "Friday"],
    ["2026-10-03T20:00:00+02:00", "on Saturday the third of October", "Saturday the third of October"],
    ["2026-10-16T20:30:00+02:00", "on Friday the sixteenth of October", "Friday the sixteenth of October"],
    ["2026-10-31T21:00:00+01:00", "on Saturday the thirty-first of October", "Saturday the thirty-first of October"],
    ["2026-11-01T20:00:00+01:00", "on Sunday the first of November", "Sunday the first of November"],
    ["2027-01-22T20:00:00+01:00", "on Friday the twenty-second of January", "Friday the twenty-second of January"],
  ])("%s → %s", (iso, phrase, bare) => {
    const d = spokenDay(iso, NOW);
    expect(d.phrase).toBe(phrase);
    expect(d.bare).toBe(bare);
  });

  it("uses Amsterdam's calendar, not UTC's", () => {
    // 23:30 UTC on the 26th is 01:30 on the 27th in Amsterdam: still tonight.
    expect(spokenDay("2026-09-26T23:30:00Z", NOW).phrase).toBe("tonight");
    // 22:30 UTC on the 27th is 00:30 on the 28th in Amsterdam: tomorrow night.
    expect(spokenDay("2026-09-27T22:30:00Z", NOW).phrase).toBe("tomorrow night");
  });

  it("says today for a gig that already started yesterday", () => {
    expect(spokenDay("2026-09-25T20:00:00+02:00", NOW).phrase).toBe("today");
  });

  it("never produces figures", () => {
    for (let d = 0; d < 400; d++) {
      const iso = new Date(NOW.getTime() + d * 86_400_000 + 8 * 3_600_000).toISOString();
      const { phrase, bare } = spokenDay(iso, NOW);
      expect(phrase).not.toMatch(/\d|undefined/);
      expect(bare).not.toMatch(/\d|undefined/);
    }
  });

  it("copes with a bad date", () => {
    expect(spokenDay("tbc", NOW).phrase).toBe("soon");
  });
});

describe("spokenTime", () => {
  it.each([
    ["2026-10-16T20:30:00+02:00", "8.30pm"],
    ["2026-10-16T20:00:00+02:00", "8pm"],
    ["2026-10-16T20:05:00+02:00", "8.05pm"],
    ["2026-10-16T12:00:00+02:00", "midday"],
    ["2026-10-16T12:45:00+02:00", "12.45pm"],
    ["2026-10-16T11:00:00+02:00", "11am"],
    ["2026-10-16T00:30:00+02:00", "12.30am"],
    ["2026-12-16T19:00:00Z", "8pm"],
  ])("%s → %s", (iso, spoken) => {
    expect(spokenTime(iso)).toBe(spoken);
  });

  it("is null for midnight (unknown time) and bad dates", () => {
    expect(spokenTime("2026-10-16T00:00:00+02:00")).toBeNull();
    expect(spokenTime("nope")).toBeNull();
  });
});

describe("spokenPrice", () => {
  it.each([
    [17, "17 euros"],
    [17.0, "17 euros"],
    [23.5, "about 24 euros"],
    [17.9, "about 18 euros"],
    [10.75, "about 11 euros"],
    [25.7, "about 26 euros"],
    [62.5, "about 63 euros"],
    [1, "1 euro"],
    [0.4, "about 1 euro"],
    [1.2, "about 1 euro"],
    [17.000000001, "17 euros"],
    [120, "120 euros"],
  ])("%s → %s", (eur, spoken) => {
    expect(spokenPrice(eur)).toBe(spoken);
  });

  it("is null when there's nothing to say", () => {
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(spokenPrice(v)).toBeNull();
    }
  });

  it("never contains decimals or a euro sign", () => {
    for (let cents = 1; cents < 20_000; cents += 7) {
      const s = spokenPrice(cents / 100)!;
      expect(s).toMatch(/^(about )?\d+ euros?$/);
    }
  });

  it("knows whole euros", () => {
    expect(isWholeEuros(17)).toBe(true);
    expect(isWholeEuros(16.999)).toBe(true);
    expect(isWholeEuros(17.5)).toBe(false);
  });
});

describe("ordinalWord", () => {
  it("names ordinals", () => {
    expect(ordinalWord(2)).toBe("second");
    expect(ordinalWord(3)).toBe("third");
    expect(ordinalWord(21)).toBe("twenty-first");
    expect(ordinalWord(0)).toBeUndefined();
    expect(ordinalWord(40)).toBeUndefined();
  });
});
