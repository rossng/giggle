import { describe, expect, it } from "vitest";
import { mulberry32, newSeed, normaliseSeed, unitHash } from "../src/random.ts";

describe("mulberry32", () => {
  it("gives the same stream for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
  });

  it("gives different streams for different seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("stays in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("treats seeds as unsigned 32-bit integers", () => {
    expect(normaliseSeed(-1)).toBe(4294967295);
    expect(normaliseSeed(3.9)).toBe(3);
    expect(normaliseSeed(Number.NaN)).toBe(0);
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
  });
});

describe("newSeed", () => {
  it("derives a 32-bit seed from a random source", () => {
    expect(newSeed(() => 0)).toBe(0);
    expect(newSeed(() => 0.5)).toBe(2 ** 31);
    const s = newSeed();
    expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
  });
});

describe("unitHash", () => {
  it("is deterministic and in [0, 1)", () => {
    expect(unitHash(9, "mb:abc")).toBe(unitHash(9, "mb:abc"));
    for (let i = 0; i < 1000; i++) {
      const x = unitHash(i, `k${i}`);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("depends on both seed and key", () => {
    expect(unitHash(1, "a")).not.toBe(unitHash(2, "a"));
    expect(unitHash(1, "a")).not.toBe(unitHash(1, "b"));
  });

  it("is roughly uniform", () => {
    const buckets = new Array<number>(10).fill(0);
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const b = Math.floor(unitHash(123, `name:artist${i}`) * 10);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n / 10 * 0.1);
  });
});
