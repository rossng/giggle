/**
 * Which artists the listener has heard, and when. Mix ordering uses it to play
 * recently heard artists less often. Plain JSON-serialisable data; every function
 * returns a new object and never mutates its input.
 */

import { DAY_MS } from "./time.ts";

/** artistKey → epoch-millisecond timestamps, oldest first. */
export type PlayHistory = Readonly<Record<string, readonly number[]>>;

export const HISTORY_MAX_AGE_DAYS = 60;
/** Enough to know "recently" and "how often"; older plays are dropped first. */
export const HISTORY_MAX_PLAYS_PER_ARTIST = 20;

export function emptyHistory(): PlayHistory {
  return {};
}

/** Adds a play of `artistKey` at `now`, dropping that artist's plays past the limits. */
export function recordPlay(
  history: PlayHistory,
  artistKey: string,
  now: Date,
  maxAgeDays: number = HISTORY_MAX_AGE_DAYS,
): PlayHistory {
  const at = now.getTime();
  const cutoff = at - maxAgeDays * DAY_MS;
  const plays = [...(history[artistKey] ?? []), at]
    .filter((t) => t >= cutoff)
    .sort((a, b) => a - b)
    .slice(-HISTORY_MAX_PLAYS_PER_ARTIST);
  return { ...history, [artistKey]: plays };
}

/** Drops plays older than `maxAgeDays`, and artists left with none. */
export function pruneHistory(
  history: PlayHistory,
  now: Date,
  maxAgeDays: number = HISTORY_MAX_AGE_DAYS,
): PlayHistory {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  const out: Record<string, number[]> = {};
  for (const [key, plays] of Object.entries(history)) {
    if (!Array.isArray(plays)) continue;
    const kept = plays.filter((t) => Number.isFinite(t) && t >= cutoff);
    if (kept.length) out[key] = kept.sort((a, b) => a - b).slice(-HISTORY_MAX_PLAYS_PER_ARTIST);
  }
  return out;
}

/**
 * Two histories as one (say, this device's and another's): the union of their plays, the
 * same play once, then pruned like `pruneHistory`. The order of the arguments doesn't matter.
 */
export function mergeHistory(
  a: PlayHistory,
  b: PlayHistory,
  now: Date,
  maxAgeDays: number = HISTORY_MAX_AGE_DAYS,
): PlayHistory {
  const out: Record<string, number[]> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[key] = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])];
  }
  return pruneHistory(out, now, maxAgeDays);
}

/** The most recent play of `artistKey`, or undefined if never heard (or out of range). */
export function lastHeard(history: PlayHistory | undefined, artistKey: string): number | undefined {
  const plays = history?.[artistKey];
  if (!plays?.length) return undefined;
  let last = -Infinity;
  for (const t of plays) if (Number.isFinite(t) && t > last) last = t;
  return last === -Infinity ? undefined : last;
}

/** Days since `artistKey` was last heard (never negative), or undefined if never. */
export function daysSinceHeard(
  history: PlayHistory | undefined,
  artistKey: string,
  now: Date,
): number | undefined {
  const last = lastHeard(history, artistKey);
  return last === undefined ? undefined : Math.max(0, (now.getTime() - last) / DAY_MS);
}

/** Reads a history back from storage, tolerating junk. */
export function parseHistory(value: unknown): PlayHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number[]> = {};
  for (const [key, plays] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(plays)) continue;
    const kept = plays.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    if (kept.length) out[key] = kept.sort((a, b) => a - b);
  }
  return out;
}
