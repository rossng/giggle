import { describe, expect, it } from "vitest";
import { MIX, mixWeight, orderKey, orderQueue } from "../src/order.ts";
import type { QueueEntry } from "../src/queue.ts";
import { DAY_MS } from "../src/time.ts";
import { entry, inDays, keys, NOW } from "./helpers.ts";

const t = NOW.getTime();
const many = (n: number, start = inDays(1)): QueueEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`name:a${i}`, start));

describe("date order", () => {
  it("puts the soonest gig first, whatever the input order", () => {
    const es = [entry("c", inDays(3)), entry("a", inDays(1)), entry("b", inDays(2))];
    expect(keys(orderQueue(es, "date", { seed: 1, now: NOW }))).toEqual(["a", "b", "c"]);
  });

  it("doesn't depend on the seed", () => {
    const es = [entry("c", inDays(3)), entry("a", inDays(1)), entry("b", inDays(1))];
    expect(orderQueue(es, "date", { seed: 1, now: NOW })).toEqual(orderQueue(es, "date", { seed: 99, now: NOW }));
  });
});

describe("shuffle", () => {
  const es = many(30);

  it("is a permutation", () => {
    const out = orderQueue(es, "shuffle", { seed: 5, now: NOW });
    expect([...keys(out)].sort()).toEqual([...keys(es)].sort());
  });

  it("gives the same order for the same seed, regardless of input order", () => {
    const a = orderQueue(es, "shuffle", { seed: 5, now: NOW });
    const b = orderQueue([...es].reverse(), "shuffle", { seed: 5, now: NOW });
    expect(keys(a)).toEqual(keys(b));
  });

  it("gives a different order for a different seed", () => {
    expect(keys(orderQueue(es, "shuffle", { seed: 5, now: NOW }))).not.toEqual(
      keys(orderQueue(es, "shuffle", { seed: 6, now: NOW })),
    );
  });

  it("ignores dates, listen-more and history", () => {
    const mixed = [entry("a", inDays(0)), entry("b", inDays(20)), entry("c", inDays(5))];
    const plain = orderQueue(mixed, "shuffle", { seed: 3, now: NOW });
    const extras = orderQueue(mixed, "shuffle", {
      seed: 3,
      now: new Date(t + 9 * DAY_MS),
      listenMore: new Set(["b"]),
      history: { a: [t] },
    });
    expect(keys(extras)).toEqual(keys(plain));
  });

  it("keeps everyone else's relative order when an artist is added", () => {
    const before = keys(orderQueue(es, "shuffle", { seed: 11, now: NOW }));
    const after = keys(orderQueue([...es, entry("name:new")], "shuffle", { seed: 11, now: NOW })).filter(
      (k) => k !== "name:new",
    );
    expect(after).toEqual(before);
  });

  it("puts each artist first about equally often", () => {
    const four = many(4);
    const firsts = new Map<string, number>();
    for (let seed = 0; seed < 4000; seed++) {
      const first = orderQueue(four, "shuffle", { seed, now: NOW })[0]!.artistKey;
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    for (const count of firsts.values()) expect(Math.abs(count - 1000)).toBeLessThan(120);
  });
});

describe("mixWeight", () => {
  it("favours gigs soon: 1 / (1 + days / 4)", () => {
    expect(mixWeight(entry("a", new Date(t).toISOString()), { now: NOW })).toBeCloseTo(1);
    expect(mixWeight(entry("a", new Date(t + 4 * DAY_MS).toISOString()), { now: NOW })).toBeCloseTo(0.5);
    expect(mixWeight(entry("a", new Date(t + 12 * DAY_MS).toISOString()), { now: NOW })).toBeCloseTo(0.25);
  });

  it("treats gigs already started as today", () => {
    expect(mixWeight(entry("a", new Date(t - DAY_MS).toISOString()), { now: NOW })).toBeCloseTo(1);
  });

  it("multiplies listen-more artists by 2.5", () => {
    const e = entry("a", new Date(t).toISOString());
    expect(mixWeight(e, { now: NOW, listenMore: new Set(["a"]) })).toBeCloseTo(MIX.listenMore);
  });

  it("down-weights artists heard in the last 3 days (×0.2) and 14 days (×0.5)", () => {
    const e = entry("a", new Date(t).toISOString());
    const heard = (days: number) => mixWeight(e, { now: NOW, history: { a: [t - days * DAY_MS] } });
    expect(heard(0)).toBeCloseTo(0.2);
    expect(heard(3)).toBeCloseTo(0.2);
    expect(heard(3.01)).toBeCloseTo(0.5);
    expect(heard(14)).toBeCloseTo(0.5);
    expect(heard(14.01)).toBeCloseTo(1);
    expect(heard(59)).toBeCloseTo(1);
  });

  it("combines the factors", () => {
    const e = entry("a", new Date(t + 4 * DAY_MS).toISOString());
    const w = mixWeight(e, { now: NOW, listenMore: new Set(["a"]), history: { a: [t - DAY_MS] } });
    expect(w).toBeCloseTo(0.5 * 2.5 * 0.2);
  });
});

describe("mix", () => {
  const es = [
    ...Array.from({ length: 10 }, (_, i) => entry(`soon${i}`, inDays(0))),
    ...Array.from({ length: 10 }, (_, i) => entry(`late${i}`, inDays(20))),
  ];

  it("is deterministic for the same seed and inputs", () => {
    const ctx = { seed: 42, now: NOW, listenMore: new Set(["late3"]), history: { soon1: [t - DAY_MS] } };
    expect(keys(orderQueue(es, "mix", ctx))).toEqual(keys(orderQueue([...es].reverse(), "mix", { ...ctx })));
  });

  it("is a permutation and changes with the seed", () => {
    const a = orderQueue(es, "mix", { seed: 1, now: NOW });
    const b = orderQueue(es, "mix", { seed: 2, now: NOW });
    expect([...keys(a)].sort()).toEqual([...keys(es)].sort());
    expect(keys(a)).not.toEqual(keys(b));
  });

  /** Average position of entries matching `prefix`, over many seeds. */
  function meanRank(input: QueueEntry[], match: (k: string) => boolean, extra: object = {}): number {
    let sum = 0;
    let n = 0;
    for (let seed = 0; seed < 300; seed++) {
      orderQueue(input, "mix", { seed, now: NOW, ...extra }).forEach((e, i) => {
        if (match(e.artistKey)) {
          sum += i;
          n++;
        }
      });
    }
    return sum / n;
  }

  it("tends to play soon gigs earlier", () => {
    expect(meanRank(es, (k) => k.startsWith("soon"))).toBeLessThan(meanRank(es, (k) => k.startsWith("late")) - 3);
  });

  it("still lets later gigs through sometimes", () => {
    let lateFirst = 0;
    for (let seed = 0; seed < 300; seed++) if (orderQueue(es, "mix", { seed, now: NOW })[0]!.artistKey.startsWith("late")) lateFirst++;
    expect(lateFirst).toBeGreaterThan(0);
    expect(lateFirst).toBeLessThan(150);
  });

  it("tends to play listen-more artists earlier", () => {
    const same = many(20);
    const boosted = new Set(keys(same).slice(0, 5));
    const withBoost = meanRank(same, (k) => boosted.has(k), { listenMore: boosted });
    const without = meanRank(same, (k) => boosted.has(k));
    expect(withBoost).toBeLessThan(without - 2);
  });

  it("tends to play recently heard artists later", () => {
    const same = many(20);
    const heard = new Set(keys(same).slice(0, 5));
    const history = Object.fromEntries([...heard].map((k) => [k, [t - DAY_MS]]));
    expect(meanRank(same, (k) => heard.has(k), { history })).toBeGreaterThan(meanRank(same, (k) => heard.has(k)) + 2);
  });

  it("has finite keys even for tiny weights", () => {
    const e = entry("a", inDays(3000));
    const k = orderKey(e, "mix", { seed: 1, now: NOW, history: { a: [t] } });
    expect(Number.isFinite(k)).toBe(true);
  });
});
