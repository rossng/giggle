import { describe, expect, it } from "vitest";
import { calendarDaysBetween, isoMs, zonedParts } from "../src/time.ts";

describe("zonedParts", () => {
  it("reads wall-clock time in Amsterdam, summer and winter", () => {
    expect(zonedParts(new Date("2026-07-01T18:30:00Z"))).toMatchObject({
      year: 2026,
      month: 7,
      day: 1,
      hour: 20,
      minute: 30,
      weekday: 3,
    });
    expect(zonedParts(new Date("2026-12-01T18:30:00Z"))).toMatchObject({ hour: 19, weekday: 2 });
  });

  it("uses 0–23 hours (midnight is 0)", () => {
    expect(zonedParts(new Date("2026-10-01T22:00:00Z")).hour).toBe(0);
  });

  it("honours other time zones", () => {
    expect(zonedParts(new Date("2026-07-01T18:30:00Z"), "Europe/London").hour).toBe(19);
  });
});

describe("calendarDaysBetween", () => {
  const now = new Date("2026-09-26T23:30:00+02:00");
  it("counts calendar days, not 24-hour periods", () => {
    expect(calendarDaysBetween(now, new Date("2026-09-26T23:59:00+02:00"))).toBe(0);
    expect(calendarDaysBetween(now, new Date("2026-09-27T00:10:00+02:00"))).toBe(1);
    expect(calendarDaysBetween(now, new Date("2026-10-03T20:00:00+02:00"))).toBe(7);
  });

  it("works across the end of summer time", () => {
    expect(calendarDaysBetween(now, new Date("2026-10-26T20:00:00+01:00"))).toBe(30);
  });

  it("is negative for the past", () => {
    expect(calendarDaysBetween(now, new Date("2026-09-25T20:00:00+02:00"))).toBe(-1);
  });
});

describe("isoMs", () => {
  it("parses ISO strings and gives NaN for nothing", () => {
    expect(isoMs("2026-09-26T00:00:00Z")).toBe(Date.UTC(2026, 8, 26));
    expect(isoMs(null)).toBeNaN();
    expect(isoMs("nonsense")).toBeNaN();
  });
});
