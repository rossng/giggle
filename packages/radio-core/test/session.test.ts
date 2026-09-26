import { describe, expect, it } from "vitest";
import { orderQueue } from "../src/order.ts";
import type { QueueEntry } from "../src/queue.ts";
import {
  filtersKey,
  parseSession,
  restoreSession,
  SESSION_VERSION,
  snapshotSession,
  type RadioSession,
} from "../src/session.ts";
import { DAY_MS } from "../src/time.ts";
import { entry, inDays, keys, NOW, track } from "./helpers.ts";

const later = new Date(NOW.getTime() + 3_600_000);

function session(queue: string[], artistIndex: number, extra: Partial<RadioSession> = {}): RadioSession {
  return {
    version: SESSION_VERSION,
    filtersKey: "f",
    seed: 7,
    order: "shuffle",
    queue,
    position: { artistIndex, trackIndex: 1, seconds: 42 },
    savedAt: NOW.toISOString(),
    ...extra,
  };
}

const E = (k: string, day = 1) => entry(k, inDays(day));
const fresh = (...ks: string[]) => ks.map((k) => E(k));

describe("snapshotSession", () => {
  it("stores keys, position and time, and survives JSON", () => {
    const s = snapshotSession({
      filtersKey: "k",
      seed: 12,
      order: "mix",
      queue: [E("a"), "b"],
      position: { artistIndex: 1, trackIndex: 0, seconds: 12.5 },
      now: NOW,
    });
    expect(s).toEqual({
      version: 1,
      filtersKey: "k",
      seed: 12,
      order: "mix",
      queue: ["a", "b"],
      position: { artistIndex: 1, trackIndex: 0, seconds: 12.5 },
      savedAt: "2026-09-26T10:00:00.000Z",
    });
    expect(parseSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("sanitises odd positions", () => {
    const s = snapshotSession({
      filtersKey: "k",
      seed: -1,
      order: "date",
      queue: [],
      position: { artistIndex: -2, trackIndex: 1.7, seconds: Number.NaN },
      now: NOW,
    });
    expect(s.position).toEqual({ artistIndex: 0, trackIndex: 1, seconds: 0 });
    expect(s.seed).toBe(4294967295);
  });
});

describe("parseSession", () => {
  const good = session(["a"], 0);
  it.each([
    ["null", null],
    ["a string", "session"],
    ["another version", { ...good, version: 2 }],
    ["a bad order", { ...good, order: "random" }],
    ["a bad queue", { ...good, queue: ["a", 3] }],
    ["a bad seed", { ...good, seed: "7" }],
    ["a bad date", { ...good, savedAt: "yesterday" }],
    ["no position", { ...good, position: undefined }],
    ["a fractional index", { ...good, position: { artistIndex: 0.5, trackIndex: 0, seconds: 0 } }],
    ["a negative index", { ...good, position: { artistIndex: -1, trackIndex: 0, seconds: 0 } }],
  ])("rejects %s", (_, value) => {
    expect(parseSession(value)).toBeNull();
  });

  it("accepts a valid session and copies it", () => {
    const parsed = parseSession(good);
    expect(parsed).toEqual(good);
    expect(parsed?.queue).not.toBe(good.queue);
  });
});

describe("filtersKey", () => {
  it("ignores key order and set-like array order", () => {
    expect(filtersKey({ days: 7, cities: ["Haarlem", "Amsterdam"] })).toBe(
      filtersKey({ cities: ["Amsterdam", "Haarlem"], days: 7 }),
    );
    expect(filtersKey({ days: 7 })).not.toBe(filtersKey({ days: 14 }));
    expect(filtersKey({ a: 1, b: undefined })).toBe(filtersKey({ a: 1 }));
    expect(typeof filtersKey(undefined)).toBe("string");
  });
});

describe("restoreSession", () => {
  const opts = { now: later };

  it("gives back the same queue and position when nothing changed", () => {
    const r = restoreSession(session(["a", "b", "c", "d"], 2), fresh("d", "c", "b", "a"), opts);
    expect(keys(r.queue)).toEqual(["a", "b", "c", "d"]);
    expect(r.position).toEqual({ artistIndex: 2, trackIndex: 1, seconds: 42 });
    expect(r.dropped).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it("uses the fresh entries' data", () => {
    const updated = { ...E("b"), name: "B (new name)" };
    const r = restoreSession(session(["a", "b"], 0), [E("a"), updated], opts);
    expect(r.queue[1]).toBe(updated);
  });

  it("drops vanished artists from the played part and shifts the position", () => {
    const r = restoreSession(session(["a", "b", "c", "d"], 2), fresh("b", "c", "d"), opts);
    expect(keys(r.queue)).toEqual(["b", "c", "d"]);
    expect(r.position).toEqual({ artistIndex: 1, trackIndex: 1, seconds: 42 });
    expect(r.dropped).toEqual(["a"]);
  });

  it("drops vanished artists from the unplayed part", () => {
    const r = restoreSession(session(["a", "b", "c", "d"], 1), fresh("a", "b", "d"), opts);
    expect(keys(r.queue)).toEqual(["a", "b", "d"]);
    expect(r.position.artistIndex).toBe(1);
  });

  it("moves on to the next artist when the current one vanished", () => {
    const r = restoreSession(session(["a", "b", "c", "d"], 1), fresh("a", "c", "d"), opts);
    expect(keys(r.queue)).toEqual(["a", "c", "d"]);
    expect(r.position).toEqual({ artistIndex: 1, trackIndex: 0, seconds: 0 });
  });

  it("wraps round when the current (last) artist vanished", () => {
    const r = restoreSession(session(["a", "b", "c"], 2), fresh("a", "b"), opts);
    expect(r.position).toEqual({ artistIndex: 0, trackIndex: 0, seconds: 0 });
  });

  it("plays a new artist next if the current one vanished at the end", () => {
    const r = restoreSession(session(["a", "b", "c"], 2), fresh("a", "b", "n"), opts);
    expect(keys(r.queue)).toEqual(["a", "b", "n"]);
    expect(r.position).toEqual({ artistIndex: 2, trackIndex: 0, seconds: 0 });
  });

  it("handles everything vanishing", () => {
    const r = restoreSession(session(["a", "b"], 1), [], opts);
    expect(r.queue).toEqual([]);
    expect(r.position).toEqual({ artistIndex: 0, trackIndex: 0, seconds: 0 });
    expect(r.dropped).toEqual(["a", "b"]);
  });

  it("handles an empty saved queue", () => {
    const r = restoreSession(session([], 0), fresh("a", "b"), opts);
    expect([...keys(r.queue)].sort()).toEqual(["a", "b"]);
    expect(r.position.artistIndex).toBe(0);
  });

  it.each(["date", "shuffle", "mix"] as const)("inserts new artists only after the current one (%s)", (order) => {
    const saved = ["a", "b", "c", "d", "e"];
    const news = ["n1", "n2", "n3", "n4", "n5", "n6"];
    for (let seed = 0; seed < 40; seed++) {
      const s = session(saved, 2, { order, seed });
      const r = restoreSession(s, [...fresh(...news), ...fresh(...saved)], opts);
      const ks = keys(r.queue);
      expect(ks.slice(0, 3)).toEqual(["a", "b", "c"]);
      expect(r.position).toEqual({ artistIndex: 2, trackIndex: 1, seconds: 42 });
      expect(ks.filter((k) => saved.includes(k))).toEqual(saved);
      expect([...ks].sort()).toEqual([...saved, ...news].sort());
      expect([...r.added].sort()).toEqual(news);
    }
  });

  it("is deterministic, and depends on the seed", () => {
    const saved = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const news = Array.from({ length: 5 }, (_, i) => `n${i}`);
    const all = [...fresh(...saved), ...fresh(...news)];
    const a = restoreSession(session(saved, 1, { seed: 1 }), all, opts);
    const b = restoreSession(session(saved, 1, { seed: 1 }), [...all].reverse(), opts);
    const c = restoreSession(session(saved, 1, { seed: 2 }), all, opts);
    expect(keys(a.queue)).toEqual(keys(b.queue));
    expect(keys(a.queue)).not.toEqual(keys(c.queue));
  });

  it("spreads new artists through the unplayed part when shuffled", () => {
    const saved = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const r = restoreSession(
      session(saved, 0, { seed: 3 }),
      [...fresh(...saved), ...fresh(...Array.from({ length: 10 }, (_, i) => `n${i}`))],
      opts,
    );
    const positions = keys(r.queue).flatMap((k, i) => (k.startsWith("n") ? [i] : []));
    expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(10);
  });

  it("merges new artists by date in date order", () => {
    const saved = [E("a", 1), E("b", 2), E("c", 4), E("d", 6)];
    const s = session(keys(saved), 1, { order: "date" });
    const r = restoreSession(s, [...saved, E("n5", 5), E("n3", 3), E("n0", 0), E("n9", 9)], opts);
    // n0 is sooner than the current artist but still only goes after it.
    expect(keys(r.queue)).toEqual(["a", "b", "n0", "n3", "c", "n5", "d", "n9"]);
  });

  it("puts an urgent new gig near the front in mix order", () => {
    const saved = Array.from({ length: 30 }, (_, i) => E(`s${i}`, 20));
    let nearFront = 0;
    for (let seed = 0; seed < 50; seed++) {
      const s = session(keys(saved), 0, { order: "mix", seed });
      const r = restoreSession(s, [...saved, E("urgent", 0)], opts);
      if (keys(r.queue).indexOf("urgent") <= 10) nearFront++;
    }
    expect(nearFront).toBeGreaterThan(35);
  });

  it("down-weights new artists heard recently in mix order", () => {
    const saved = Array.from({ length: 30 }, (_, i) => E(`s${i}`, 5));
    let sumHeard = 0;
    let sumFresh = 0;
    for (let seed = 0; seed < 80; seed++) {
      const s = session(keys(saved), 0, { order: "mix", seed });
      const heard = restoreSession(s, [...saved, E("x", 5)], {
        now: later,
        history: { x: [later.getTime() - DAY_MS] },
      });
      const notHeard = restoreSession(s, [...saved, E("x", 5)], opts);
      sumHeard += keys(heard.queue).indexOf("x");
      sumFresh += keys(notHeard.queue).indexOf("x");
    }
    expect(sumHeard).toBeGreaterThan(sumFresh);
  });

  it("keeps the current artist current even if the fresh order would differ", () => {
    const es = fresh("a", "b", "c", "d", "e");
    const reordered = orderQueue(es, "shuffle", { seed: 999, now: NOW });
    const r = restoreSession(session(["e", "d", "c", "b", "a"], 3), reordered, opts);
    expect(r.queue[r.position.artistIndex]?.artistKey).toBe("b");
    expect(keys(r.queue)).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("clamps the track when the current artist now has fewer tracks", () => {
    const one: QueueEntry = { ...E("b"), tracks: [track("b-only")] };
    const r = restoreSession(session(["a", "b"], 1), [E("a"), one], opts);
    expect(r.position).toEqual({ artistIndex: 1, trackIndex: 0, seconds: 0 });
  });

  it("tolerates repeated keys and an out-of-range position in the session", () => {
    const r = restoreSession(session(["a", "b", "a", "c"], 9), fresh("a", "b", "c"), opts);
    expect(keys(r.queue)).toEqual(["a", "b", "c"]);
    expect(r.position.artistIndex).toBe(2);
  });

  it("ignores duplicate fresh entries", () => {
    const r = restoreSession(session(["a"], 0), [E("a"), E("n"), E("n")], opts);
    expect(keys(r.queue)).toEqual(["a", "n"]);
    expect(r.added).toEqual(["n"]);
  });

  it("doesn't mutate its inputs", () => {
    const s = session(["a", "b", "c"], 1);
    const f = fresh("c", "x", "a");
    const sCopy = structuredClone(s);
    const fKeys = keys(f);
    restoreSession(s, f, opts);
    expect(s).toEqual(sCopy);
    expect(keys(f)).toEqual(fKeys);
  });
});
