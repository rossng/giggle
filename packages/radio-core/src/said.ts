/**
 * What the presenter has already said about each artist, so repeat plays rotate
 * through different facts ("from Glasgow" one day, "together since 1995" the next).
 * Plain JSON-serialisable data, stored next to the `PlayHistory`; every function
 * returns a new object and never mutates its input.
 */

import { DAY_MS } from "./time.ts";

/** One fact said about an artist: its kind ("origin", "genre"…) and when. */
export interface SaidFact {
  kind: string;
  at: number;
}

/** artistKey → facts said, oldest first. */
export type SaidMemory = Readonly<Record<string, readonly SaidFact[]>>;

export const SAID_MAX_AGE_DAYS = 60;
/** Enough to rotate through every kind of fact a couple of times. */
export const SAID_MAX_PER_ARTIST = 16;

export function emptySaid(): SaidMemory {
  return {};
}

/** Adds `kinds` said about `artistKey` at `now`. */
export function recordSaid(
  memory: SaidMemory,
  artistKey: string,
  kinds: readonly string[],
  now: Date,
): SaidMemory {
  if (!kinds.length) return memory;
  const at = now.getTime();
  const cutoff = at - SAID_MAX_AGE_DAYS * DAY_MS;
  const facts = [...(memory[artistKey] ?? []), ...kinds.map((kind) => ({ kind, at }))]
    .filter((f) => f.at >= cutoff)
    .slice(-SAID_MAX_PER_ARTIST);
  return { ...memory, [artistKey]: facts };
}

/**
 * When each kind of fact was last said about `artistKey`, as an order: the index of its
 * latest mention in the memory (higher = more recent). Kinds never said are absent.
 */
export function saidOrder(memory: SaidMemory | undefined, artistKey: string): Map<string, number> {
  const out = new Map<string, number>();
  (memory?.[artistKey] ?? []).forEach((f, i) => out.set(f.kind, i));
  return out;
}

/** Drops facts older than `maxAgeDays`, and artists left with none. */
export function pruneSaid(memory: SaidMemory, now: Date, maxAgeDays: number = SAID_MAX_AGE_DAYS): SaidMemory {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  const out: Record<string, SaidFact[]> = {};
  for (const [key, facts] of Object.entries(memory)) {
    const kept = facts.filter((f) => f.at >= cutoff);
    if (kept.length) out[key] = kept.slice(-SAID_MAX_PER_ARTIST);
  }
  return out;
}

/** Reads a memory back from storage, tolerating junk. */
export function parseSaid(value: unknown): SaidMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, SaidFact[]> = {};
  for (const [key, facts] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(facts)) continue;
    const kept = facts
      .filter(
        (f): f is SaidFact =>
          !!f &&
          typeof f === "object" &&
          typeof (f as SaidFact).kind === "string" &&
          typeof (f as SaidFact).at === "number" &&
          Number.isFinite((f as SaidFact).at),
      )
      .map((f) => ({ kind: f.kind, at: f.at }))
      .sort((a, b) => a.at - b.at)
      .slice(-SAID_MAX_PER_ARTIST);
    if (kept.length) out[key] = kept;
  }
  return out;
}
