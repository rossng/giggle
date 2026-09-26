import { describe, expect, it } from "vitest";
import { emptySaid, parseSaid, pruneSaid, recordSaid, SAID_MAX_PER_ARTIST, saidOrder } from "../src/said.ts";
import { NOW } from "./helpers.ts";

const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("said memory", () => {
  it("records facts per artist without mutating", () => {
    const empty = emptySaid();
    const one = recordSaid(empty, "mb:a", ["origin"], NOW);
    expect(empty).toEqual({});
    expect(one).toEqual({ "mb:a": [{ kind: "origin", at: NOW.getTime() }] });
    expect(recordSaid(one, "mb:a", [], NOW)).toBe(one);
  });

  it("orders kinds by when they were last said", () => {
    let m = recordSaid({}, "mb:a", ["origin"], at(0));
    m = recordSaid(m, "mb:a", ["genre"], at(1));
    m = recordSaid(m, "mb:a", ["origin"], at(2));
    const order = saidOrder(m, "mb:a");
    expect(order.get("origin")).toBeGreaterThan(order.get("genre")!);
    expect(order.has("formed")).toBe(false);
    expect(saidOrder(undefined, "mb:a").size).toBe(0);
  });

  it("keeps a bounded, recent memory", () => {
    let m = {};
    for (let i = 0; i < 40; i++) m = recordSaid(m, "mb:a", [`k${i}`], at(i / 10));
    expect(m["mb:a" as keyof typeof m]).toHaveLength(SAID_MAX_PER_ARTIST);
    const old = recordSaid({}, "mb:b", ["origin"], at(-100));
    expect(pruneSaid(old, NOW)).toEqual({});
    expect(recordSaid(old, "mb:b", ["genre"], NOW)["mb:b"]!.map((f) => f.kind)).toEqual(["genre"]);
  });

  it("survives JSON and tolerates junk", () => {
    const m = recordSaid(recordSaid({}, "mb:a", ["origin", "genre"], NOW), "mb:b", ["ticket"], NOW);
    expect(parseSaid(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(parseSaid(null)).toEqual({});
    expect(parseSaid([1, 2])).toEqual({});
    expect(parseSaid({ a: "x", b: [{ kind: "origin", at: "no" }, { kind: 3, at: 1 }, null, { kind: "genre", at: 5 }] })).toEqual({
      b: [{ kind: "genre", at: 5 }],
    });
  });
});
