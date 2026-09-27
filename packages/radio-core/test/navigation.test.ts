import { describe, expect, it } from "vitest";
import {
  clampPosition,
  currentEntry,
  currentTrack,
  dropTrack,
  nextArtistPosition,
  nextPosition,
  previousPosition,
  START,
} from "../src/navigation.ts";
import { entry, track } from "./helpers.ts";

const q = [entry("a"), entry("b", undefined, { tracks: [track("b-1")] }), entry("c")];

describe("navigation", () => {
  it("moves through an artist's tracks, then to the next artist", () => {
    let p = { ...START };
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(currentTrack(q, p)!.videoId);
      p = nextPosition(q, p);
    }
    expect(seen).toEqual(["a-1", "a-2", "b-1", "c-1", "c-2", "a-1"]);
  });

  it("goes back a track, or to the previous artist's first track", () => {
    expect(previousPosition(q, { artistIndex: 0, trackIndex: 1, seconds: 30 })).toEqual({ artistIndex: 0, trackIndex: 0, seconds: 0 });
    expect(previousPosition(q, { artistIndex: 2, trackIndex: 0, seconds: 0 })).toEqual({ artistIndex: 1, trackIndex: 0, seconds: 0 });
    expect(previousPosition(q, START)).toEqual({ artistIndex: 2, trackIndex: 0, seconds: 0 });
  });

  it("skips to the next artist, wrapping round", () => {
    expect(nextArtistPosition(q, { artistIndex: 0, trackIndex: 1, seconds: 12 })).toEqual({ artistIndex: 1, trackIndex: 0, seconds: 0 });
    expect(nextArtistPosition(q, { artistIndex: 2, trackIndex: 0, seconds: 0 }).artistIndex).toBe(0);
  });

  it("copes with an empty queue", () => {
    expect(nextPosition([], START)).toEqual(START);
    expect(previousPosition([], START)).toEqual(START);
    expect(currentEntry([], START)).toBeUndefined();
    expect(currentTrack([], START)).toBeUndefined();
  });

  it("clamps positions into the queue", () => {
    expect(clampPosition(q, { artistIndex: 9, trackIndex: 0, seconds: 5 })).toEqual({ artistIndex: 2, trackIndex: 0, seconds: 5 });
    expect(clampPosition(q, { artistIndex: 1, trackIndex: 1, seconds: 5 })).toEqual({ artistIndex: 1, trackIndex: 0, seconds: 0 });
    expect(clampPosition(q, { artistIndex: -1, trackIndex: Number.NaN, seconds: -3 })).toEqual(START);
    expect(clampPosition([], { artistIndex: 3, trackIndex: 1, seconds: 5 })).toEqual(START);
  });

  describe("dropTrack", () => {
    const ids = (queue: typeof q) => queue.map((e) => e.tracks.map((t) => t.videoId).join(","));

    it("goes on to the artist's next track, now in its place", () => {
      const { queue, next } = dropTrack(q, { artistIndex: 0, trackIndex: 0, seconds: 20 });
      expect(ids(queue)).toEqual(["a-2", "b-1", "c-1,c-2"]);
      expect(currentTrack(queue, next)?.videoId).toBe("a-2");
    });

    it("goes on to the next artist after an artist's last track", () => {
      const { queue, next } = dropTrack(q, { artistIndex: 0, trackIndex: 1, seconds: 0 });
      expect(ids(queue)).toEqual(["a-1", "b-1", "c-1,c-2"]);
      expect(currentTrack(queue, next)?.videoId).toBe("b-1");
    });

    it("drops an artist with no tracks left, wrapping round", () => {
      const middle = dropTrack(q, { artistIndex: 1, trackIndex: 0, seconds: 0 });
      expect(ids(middle.queue)).toEqual(["a-1,a-2", "c-1,c-2"]);
      expect(currentTrack(middle.queue, middle.next)?.videoId).toBe("c-1");
      const last = dropTrack([q[0]!, q[1]!], { artistIndex: 1, trackIndex: 0, seconds: 0 });
      expect(currentTrack(last.queue, last.next)?.videoId).toBe("a-1");
    });

    it("leaves an empty queue when the last track goes", () => {
      expect(dropTrack([q[1]!], START)).toEqual({ queue: [], next: START });
      expect(dropTrack([], START)).toEqual({ queue: [], next: START });
    });
  });
});
