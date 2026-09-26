/**
 * Seeded randomness. Everything in radio-core that looks random takes either an `Rng`
 * (a stream) or a seed, so a shuffle stays put until the listener asks for a new one,
 * and tests are deterministic.
 */

/** A source of uniform numbers in [0, 1), like `Math.random`. */
export type Rng = () => number;

/** Seeds are unsigned 32-bit integers. */
export function normaliseSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

/** mulberry32: a small, fast, well-mixed seeded generator. */
export function mulberry32(seed: number): Rng {
  let a = normaliseSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed, e.g. when the listener presses "reshuffle". */
export function newSeed(random: Rng = Math.random): number {
  return Math.floor(random() * 4294967296) >>> 0;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A uniform number in [0, 1) that depends only on `seed` and `key`. Used to give
 * each artist its own draw, so adding or removing one artist doesn't reshuffle the
 * rest.
 */
export function unitHash(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ normaliseSeed(seed);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = fmix32(h ^ Math.imul(normaliseSeed(seed), 0x9e3779b1));
  return h / 4294967296;
}
