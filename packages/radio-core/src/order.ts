/**
 * Queue ordering.
 *
 * - `date`: soonest gig first.
 * - `shuffle`: a seeded uniform shuffle.
 * - `mix`: a seeded weighted shuffle (Efraimidis–Spirakis): each artist draws
 *   u^(1/weight) and the highest draws go first, so heavier artists tend to come
 *   earlier without ever being guaranteed a slot. See `mixWeight`.
 *
 * Each artist's draw depends only on (seed, artistKey), not on who else is in the
 * queue, so artists coming and going don't reshuffle everyone else.
 */

import { daysSinceHeard, type PlayHistory } from "./history.ts";
import { compareByDate, type QueueEntry } from "./queue.ts";
import { unitHash } from "./random.ts";
import { DAY_MS, isoMs } from "./time.ts";

export type RadioOrder = "date" | "shuffle" | "mix";
export const RADIO_ORDERS: readonly RadioOrder[] = ["date", "shuffle", "mix"];

export interface OrderContext {
  seed: number;
  now: Date;
  /** Artists the listener marked "listen more". */
  listenMore?: ReadonlySet<string>;
  history?: PlayHistory;
}

/** Tunables for `mixWeight`, exported so the UI can explain them. */
export const MIX = {
  /** Soonness is 1 / (1 + days / soonDays): today 1, in 4 days 0.5, in 12 days 0.25. */
  soonDays: 4,
  listenMore: 2.5,
  /** Heard within this many days: × recentFactor. */
  recentDays: 3,
  recentFactor: 0.2,
  /** Otherwise heard within this many days: × lessRecentFactor. */
  lessRecentDays: 14,
  lessRecentFactor: 0.5,
} as const;

/** The `mix` weight of an entry: favours gigs soon, "listen more", and not-heard-lately. */
export function mixWeight(entry: QueueEntry, ctx: Omit<OrderContext, "seed">): number {
  const start = isoMs(entry.gig.start);
  const days = Number.isNaN(start) ? 0 : Math.max(0, (start - ctx.now.getTime()) / DAY_MS);
  let weight = 1 / (1 + days / MIX.soonDays);
  if (ctx.listenMore?.has(entry.artistKey)) weight *= MIX.listenMore;
  const heard = daysSinceHeard(ctx.history, entry.artistKey, ctx.now);
  if (heard !== undefined) {
    if (heard <= MIX.recentDays) weight *= MIX.recentFactor;
    else if (heard <= MIX.lessRecentDays) weight *= MIX.lessRecentFactor;
  }
  return weight;
}

const SHUFFLE_SALT = "shuffle:";
const MIX_SALT = "mix:";

/**
 * The sort key of an entry under `order` (higher plays sooner). For `mix` this is
 * log(u) / weight, which orders exactly like u^(1/weight) without underflow.
 * `date` returns minus the start time.
 */
export function orderKey(entry: QueueEntry, order: RadioOrder, ctx: OrderContext): number {
  switch (order) {
    case "date":
      return -isoMs(entry.gig.start);
    case "shuffle":
      return unitHash(ctx.seed, SHUFFLE_SALT + entry.artistKey);
    case "mix": {
      // 1 - hash is in (0, 1], so the log is finite.
      const u = 1 - unitHash(ctx.seed, MIX_SALT + entry.artistKey);
      return Math.log(u) / mixWeight(entry, ctx);
    }
  }
}

function byKeyThenArtist(ka: number, kb: number, a: QueueEntry, b: QueueEntry): number {
  if (ka !== kb) return kb - ka;
  return a.artistKey < b.artistKey ? -1 : a.artistKey > b.artistKey ? 1 : 0;
}

/** A new array in the requested order. Same seed and inputs give the same order. */
export function orderQueue(
  entries: readonly QueueEntry[],
  order: RadioOrder,
  ctx: OrderContext,
): QueueEntry[] {
  if (order === "date") return [...entries].sort(compareByDate);
  const keyed = entries.map((e) => ({ e, k: orderKey(e, order, ctx) }));
  keyed.sort((x, y) => byKeyThenArtist(x.k, y.k, x.e, y.e));
  return keyed.map((x) => x.e);
}
