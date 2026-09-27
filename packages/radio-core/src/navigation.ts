/** Moving around the queue. Positions wrap around at both ends, like a radio loop. */

import type { QueueEntry } from "./queue.ts";
import type { Track } from "./types.ts";

export interface QueuePosition {
  artistIndex: number;
  trackIndex: number;
  /** Seconds into the current track. */
  seconds: number;
}

export const START: QueuePosition = Object.freeze({ artistIndex: 0, trackIndex: 0, seconds: 0 });

function wrap(i: number, length: number): number {
  return length ? ((i % length) + length) % length : 0;
}

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** A valid position in `queue` (START for an empty queue). */
export function clampPosition(queue: readonly QueueEntry[], pos: QueuePosition): QueuePosition {
  if (!queue.length) return { ...START };
  const artistIndex = Math.min(whole(pos.artistIndex), queue.length - 1);
  const tracks = queue[artistIndex]?.tracks.length ?? 1;
  const trackIndex = Math.min(whole(pos.trackIndex), Math.max(0, tracks - 1));
  const seconds =
    trackIndex === whole(pos.trackIndex) && Number.isFinite(pos.seconds) ? Math.max(0, pos.seconds) : 0;
  return { artistIndex, trackIndex, seconds };
}

export function currentEntry(
  queue: readonly QueueEntry[],
  pos: QueuePosition,
): QueueEntry | undefined {
  return queue[pos.artistIndex];
}

export function currentTrack(queue: readonly QueueEntry[], pos: QueuePosition): Track | undefined {
  return queue[pos.artistIndex]?.tracks[pos.trackIndex];
}

/** The next track: the same artist's next one, else the next artist's first. */
export function nextPosition(queue: readonly QueueEntry[], pos: QueuePosition): QueuePosition {
  const entry = queue[pos.artistIndex];
  if (entry && pos.trackIndex + 1 < entry.tracks.length) {
    return { artistIndex: pos.artistIndex, trackIndex: pos.trackIndex + 1, seconds: 0 };
  }
  return nextArtistPosition(queue, pos);
}

/** The previous track: the same artist's previous one, else the previous artist's first. */
export function previousPosition(queue: readonly QueueEntry[], pos: QueuePosition): QueuePosition {
  if (pos.trackIndex > 0 && queue[pos.artistIndex]) {
    return { artistIndex: pos.artistIndex, trackIndex: pos.trackIndex - 1, seconds: 0 };
  }
  return { artistIndex: wrap(pos.artistIndex - 1, queue.length), trackIndex: 0, seconds: 0 };
}

export function nextArtistPosition(queue: readonly QueueEntry[], pos: QueuePosition): QueuePosition {
  return { artistIndex: wrap(pos.artistIndex + 1, queue.length), trackIndex: 0, seconds: 0 };
}

/**
 * `queue` without the track at `pos` (and without its artist, if it was their last one), and
 * where to go on: what would have come after it.
 */
export function dropTrack(
  queue: readonly QueueEntry[],
  pos: QueuePosition,
): { queue: QueueEntry[]; next: QueuePosition } {
  const at = clampPosition(queue, pos);
  const entry = queue[at.artistIndex];
  if (!entry) return { queue: [...queue], next: { ...START } };
  const tracks = entry.tracks.filter((_, i) => i !== at.trackIndex);
  if (tracks.length) {
    const out = queue.map((e) => (e === entry ? { ...entry, tracks } : e));
    const next =
      at.trackIndex < tracks.length
        ? { artistIndex: at.artistIndex, trackIndex: at.trackIndex, seconds: 0 }
        : nextArtistPosition(out, at);
    return { queue: out, next };
  }
  const out = queue.filter((e) => e !== entry);
  return { queue: out, next: { artistIndex: wrap(at.artistIndex, out.length), trackIndex: 0, seconds: 0 } };
}
