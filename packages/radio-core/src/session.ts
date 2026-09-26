/**
 * Saving and resuming a listening session.
 *
 * A session stores the queue as artist keys only. On restore the queue is rebuilt
 * against fresh entries (tonight's data may have changed since):
 *
 * - the played part (before the current artist) keeps its order;
 * - artists that are gone (gig vanished or cancelled, now "not for me", no tracks)
 *   are dropped, and the position moves with them;
 * - the current artist stays current; if it's gone, the next surviving artist
 *   becomes current from its first track;
 * - artists that are new since the snapshot go only into the unplayed part, at
 *   deterministic spots chosen by the session's order and seed.
 */

import type { PlayHistory } from "./history.ts";
import { clampPosition, START, type QueuePosition } from "./navigation.ts";
import { orderKey, RADIO_ORDERS, type RadioOrder } from "./order.ts";
import { compareByDate, type QueueEntry } from "./queue.ts";
import { normaliseSeed, unitHash } from "./random.ts";

export const SESSION_VERSION = 1;

export interface RadioSession {
  version: typeof SESSION_VERSION;
  /** Opaque: identifies the filters the queue was built with (see `filtersKey`). */
  filtersKey: string;
  seed: number;
  order: RadioOrder;
  /** Artist keys in play order. */
  queue: string[];
  position: QueuePosition;
  /** ISO 8601. */
  savedAt: string;
}

export interface SnapshotInput {
  filtersKey: string;
  seed: number;
  order: RadioOrder;
  queue: readonly (QueueEntry | string)[];
  position: QueuePosition;
  now: Date;
}

export function snapshotSession(input: SnapshotInput): RadioSession {
  return {
    version: SESSION_VERSION,
    filtersKey: input.filtersKey,
    seed: normaliseSeed(input.seed),
    order: input.order,
    queue: input.queue.map((e) => (typeof e === "string" ? e : e.artistKey)),
    position: {
      artistIndex: Math.max(0, Math.floor(input.position.artistIndex) || 0),
      trackIndex: Math.max(0, Math.floor(input.position.trackIndex) || 0),
      seconds: Number.isFinite(input.position.seconds) ? Math.max(0, input.position.seconds) : 0,
    },
    savedAt: input.now.toISOString(),
  };
}

/** A stable string for a filters object: key order and set-like array order don't matter. */
export function filtersKey(filters: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(norm);
      return items.map((x) => JSON.stringify(x)).sort();
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(filters)) ?? "";
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Reads a session back from storage; null if it isn't one (or is from another version). */
export function parseSession(value: unknown): RadioSession | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  const p = s.position as Record<string, unknown> | undefined;
  if (
    s.version !== SESSION_VERSION ||
    typeof s.filtersKey !== "string" ||
    typeof s.seed !== "number" ||
    !Number.isFinite(s.seed) ||
    !RADIO_ORDERS.includes(s.order as RadioOrder) ||
    !Array.isArray(s.queue) ||
    !s.queue.every((k) => typeof k === "string") ||
    typeof s.savedAt !== "string" ||
    Number.isNaN(Date.parse(s.savedAt)) ||
    !p ||
    typeof p !== "object" ||
    !isCount(p.artistIndex) ||
    !isCount(p.trackIndex) ||
    typeof p.seconds !== "number" ||
    !Number.isFinite(p.seconds)
  ) {
    return null;
  }
  return {
    version: SESSION_VERSION,
    filtersKey: s.filtersKey,
    seed: normaliseSeed(s.seed),
    order: s.order as RadioOrder,
    queue: [...(s.queue as string[])],
    position: { artistIndex: p.artistIndex, trackIndex: p.trackIndex, seconds: Math.max(0, p.seconds) },
    savedAt: s.savedAt,
  };
}

export interface RestoreOptions {
  now: Date;
  history?: PlayHistory;
  listenMore?: ReadonlySet<string>;
}

export interface RestoredSession {
  queue: QueueEntry[];
  position: QueuePosition;
  /** Keys in the session that aren't in the fresh entries. */
  dropped: string[];
  /** Keys in the fresh entries that weren't in the session. */
  added: string[];
}

const INSERT_SALT = "insert:";

/**
 * Rebuilds a saved queue against `fresh` entries (any order; typically the output
 * of `buildQueue` for the same filters). See the module comment for the rules.
 */
export function restoreSession(
  session: RadioSession,
  fresh: readonly QueueEntry[],
  options: RestoreOptions,
): RestoredSession {
  const byKey = new Map<string, QueueEntry>();
  for (const e of fresh) if (!byKey.has(e.artistKey)) byKey.set(e.artistKey, e);

  // The saved queue without repeats; a repeated key keeps its first place.
  const saved: string[] = [];
  const seen = new Set<string>();
  for (const key of session.queue) {
    if (!seen.has(key)) {
      seen.add(key);
      saved.push(key);
    }
  }
  const savedIndex = Math.min(
    Math.max(0, Math.floor(session.position.artistIndex) || 0),
    Math.max(0, session.queue.length - 1),
  );
  // Where the current artist sits in the de-duplicated list.
  const currentKey = session.queue[savedIndex];
  const current = currentKey === undefined ? 0 : saved.indexOf(currentKey);

  const dropped = saved.filter((k) => !byKey.has(k));
  const played: QueueEntry[] = [];
  const unplayed: QueueEntry[] = [];
  let currentEntry: QueueEntry | undefined;
  saved.forEach((key, i) => {
    const entry = byKey.get(key);
    if (!entry) return;
    if (i < current) played.push(entry);
    else if (i === current) currentEntry = entry;
    else unplayed.push(entry);
  });

  const added = fresh.filter((e) => !seen.has(e.artistKey) && byKey.get(e.artistKey) === e);
  const upcoming = insertNew(unplayed, added, session, options);

  const queue = [...played, ...(currentEntry ? [currentEntry] : []), ...upcoming];
  let position: QueuePosition;
  if (!queue.length) {
    position = { ...START };
  } else if (currentEntry) {
    position = clampPosition(queue, {
      artistIndex: played.length,
      trackIndex: session.position.trackIndex,
      seconds: session.position.seconds,
    });
  } else {
    // The current artist is gone: carry on with whoever comes next (wrapping round).
    const next = played.length < queue.length ? played.length : 0;
    position = { artistIndex: next, trackIndex: 0, seconds: 0 };
  }
  return { queue, position, dropped, added: added.map((e) => e.artistKey) };
}

/** Places `added` among `unplayed` without reordering `unplayed`. */
function insertNew(
  unplayed: readonly QueueEntry[],
  added: readonly QueueEntry[],
  session: RadioSession,
  options: RestoreOptions,
): QueueEntry[] {
  if (!added.length) return [...unplayed];
  const m = unplayed.length;
  const ctx = {
    seed: session.seed,
    now: options.now,
    ...(options.history ? { history: options.history } : {}),
    ...(options.listenMore ? { listenMore: options.listenMore } : {}),
  };

  // For each new entry: the gap it goes into (0 = straight after the current artist,
  // m = at the end) and a rank for ordering new entries that share a gap.
  let placed: { entry: QueueEntry; slot: number; rank: number }[];
  if (session.order === "date") {
    placed = added.map((entry) => {
      const after = unplayed.findIndex((u) => compareByDate(u, entry) > 0);
      return { entry, slot: after < 0 ? m : after, rank: -Date.parse(entry.gig.start) };
    });
  } else if (session.order === "shuffle") {
    placed = added.map((entry) => {
      const u = unitHash(session.seed, INSERT_SALT + entry.artistKey);
      return { entry, slot: Math.min(m, Math.floor(u * (m + 1))), rank: orderKey(entry, "shuffle", ctx) };
    });
  } else {
    // Mix: rank everyone still to play by their mix key; a new artist goes in at the
    // same relative depth, so an urgent new gig lands near the front.
    const keys = [...unplayed, ...added].map((e) => orderKey(e, "mix", ctx));
    const total = keys.length;
    placed = added.map((entry, j) => {
      const k = keys[m + j] ?? 0;
      const ahead = keys.filter((x) => x > k).length;
      return { entry, slot: Math.min(m, Math.floor((ahead / total) * (m + 1))), rank: k };
    });
  }

  placed.sort(
    (a, b) =>
      a.slot - b.slot ||
      b.rank - a.rank ||
      (a.entry.artistKey < b.entry.artistKey ? -1 : a.entry.artistKey > b.entry.artistKey ? 1 : 0),
  );
  const out: QueueEntry[] = [];
  let p = 0;
  for (let i = 0; i <= m; i++) {
    while (p < placed.length && placed[p]!.slot === i) out.push(placed[p++]!.entry);
    const u = unplayed[i];
    if (u) out.push(u);
  }
  return out;
}
