import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckingController } from "../src/ducking.ts";
import { DEFAULT_TIMING, planSegment, runSegment, type SegmentPlan } from "../src/timing.ts";

describe("planSegment", () => {
  const intro = (seconds: number) => ({ kind: "intro" as const, seconds });

  it("says nothing with the voice off or no line", () => {
    expect(planSegment({ line: intro(4), voice: "off" })).toMatchObject({ mode: "skip", reason: "voice off" });
    expect(planSegment({ line: null, voice: "short" })).toMatchObject({ mode: "skip", kind: null });
  });

  it("back-announces over the outro, ending 1.5 s before the track does", () => {
    const plan = planSegment({ line: { kind: "back", seconds: 3 }, voice: "short", finishing: { durationSeconds: 200 } });
    expect(plan).toMatchObject({ mode: "backAnnounce", startAt: 195.5, duckTo: 20, leadInSeconds: 0 });
  });

  it("skips back-announcements after a skip, for short tracks, or with no duration", () => {
    const back = { kind: "back" as const, seconds: 3 };
    expect(planSegment({ line: back, voice: "short", finishing: { durationSeconds: 200, skipped: true } }).mode).toBe("skip");
    expect(planSegment({ line: back, voice: "short", finishing: { durationSeconds: 60 } }).mode).toBe("skip");
    expect(planSegment({ line: back, voice: "short", finishing: { durationSeconds: null } }).mode).toBe("skip");
    expect(planSegment({ line: back, voice: "short" }).mode).toBe("skip");
  });

  it("says micro-announcements over the intro, unless it spoke very recently", () => {
    const micro = { kind: "micro" as const, seconds: 2 };
    expect(planSegment({ line: micro, voice: "short" })).toMatchObject({ mode: "overIntro", startAt: 0, duckTo: 20 });
    expect(planSegment({ line: micro, voice: "short", sinceLastSpeechSeconds: 45 }).mode).toBe("overIntro");
    expect(planSegment({ line: micro, voice: "short", sinceLastSpeechSeconds: 10 })).toMatchObject({ mode: "skip", reason: "spoke too recently" });
  });

  it("says short links over the intro and longer ones before the track", () => {
    expect(planSegment({ line: intro(5.5), voice: "short" }).mode).toBe("overIntro");
    expect(planSegment({ line: intro(6), voice: "short" }).mode).toBe("overIntro");
    const long = planSegment({ line: intro(8), voice: "short" });
    expect(long).toMatchObject({ mode: "beforeTrack", duckTo: 0, leadInSeconds: 1, leadInVolume: 20, fadeInSeconds: 1.5, speechSeconds: 8 });
  });

  it("always says name-mode links over the intro", () => {
    expect(planSegment({ line: intro(8), voice: "name" }).mode).toBe("overIntro");
    expect(planSegment({ line: { ...intro(8), mode: "name" }, voice: "short" }).mode).toBe("overIntro");
  });

  it("takes options", () => {
    const o = { overIntroMaxSeconds: 10, duckTo: 30 };
    expect(planSegment({ line: intro(8), voice: "short", options: o })).toMatchObject({ mode: "overIntro", duckTo: 30 });
    expect(DEFAULT_TIMING.outroMarginSeconds).toBe(1.5);
  });
});

class FakePlayer {
  volume: number;
  playing = false;
  readonly events: string[] = [];
  constructor(volume = 80) {
    this.volume = volume;
  }
  getVolume(): number {
    return this.volume;
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  play(): void {
    this.playing = true;
    this.events.push(`play@${Date.now()}`);
  }
}

/** A voice that talks for `ms` (or until aborted), noting the music volume as it starts. */
function voice(player: FakePlayer, ms: number) {
  const heard: number[] = [];
  let aborted = false;
  const speak = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      heard.push(player.volume);
      player.events.push(`speak@${Date.now()}`);
      const t = setTimeout(() => {
        player.events.push(`done@${Date.now()}`);
        resolve();
      }, ms);
      signal.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(t);
        resolve();
      });
    });
  return {
    speak,
    heard,
    get aborted() {
      return aborted;
    },
  };
}

describe("runSegment (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const plan = (p: Partial<SegmentPlan> & Pick<SegmentPlan, "mode">): SegmentPlan => ({
    kind: "intro",
    speechSeconds: 3,
    startAt: 0,
    duckTo: 20,
    leadInSeconds: 0,
    leadInVolume: 20,
    fadeInSeconds: 0,
    ...p,
  });

  it("back-announces when the outro comes, ducked, then restores the volume", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 0 });
    const v = voice(player, 3000);
    const done = runSegment(plan({ mode: "backAnnounce", kind: "back", startAt: 195.5 }), { player, speak: v.speak, ducking, positionSeconds: 190 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(v.heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(v.heard).toEqual([20]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await done).toEqual({ spoke: true, startedTrack: false, cancelled: false });
    expect(player.volume).toBe(80);
    expect(player.playing).toBe(false);
  });

  it("can cancel a back-announcement before it starts", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 0 });
    const v = voice(player, 3000);
    const abort = new AbortController();
    const done = runSegment(plan({ mode: "backAnnounce", kind: "back", startAt: 100 }), { player, speak: v.speak, ducking, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort(); // the listener skipped
    expect(await done).toMatchObject({ spoke: false, cancelled: true });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(v.heard).toEqual([]);
  });

  it("speaks over the intro: starts the track ducked, then fades back up", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 300 });
    const v = voice(player, 2000);
    const done = runSegment(plan({ mode: "overIntro", kind: "micro" }), { player, speak: v.speak, ducking });
    await vi.advanceTimersByTimeAsync(300);
    expect(player.playing).toBe(true);
    expect(v.heard).toEqual([20]);
    await vi.advanceTimersByTimeAsync(2300);
    expect(await done).toEqual({ spoke: true, startedTrack: true, cancelled: false });
    expect(player.volume).toBe(80);
  });

  it("before the track: silence, then the track comes in a second before the voice ends", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 0 });
    const v = voice(player, 8000);
    let started = -1;
    const p = plan({ mode: "beforeTrack", speechSeconds: 8, duckTo: 0, leadInSeconds: 1, leadInVolume: 20, fadeInSeconds: 1.5 });
    const done = runSegment(p, {
      player,
      speak: v.speak,
      ducking,
      startTrack: () => {
        started = Date.now();
        player.play();
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(v.heard).toEqual([0]);
    expect(player.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(7000);
    expect(started).toBe(7000);
    await vi.advanceTimersByTimeAsync(600);
    expect(player.volume).toBe(20); // up under the last words
    await vi.advanceTimersByTimeAsync(400); // speech ends at 8 s
    expect(player.volume).toBeLessThan(80);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toEqual({ spoke: true, startedTrack: true, cancelled: false });
    expect(player.volume).toBe(80);
  });

  it("before the track: starts it at once if the voice finishes early", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 0 });
    const v = voice(player, 3000);
    const p = plan({ mode: "beforeTrack", speechSeconds: 8, duckTo: 0, leadInSeconds: 1, fadeInSeconds: 1 });
    const done = runSegment(p, { player, speak: v.speak, ducking });
    await vi.advanceTimersByTimeAsync(3000);
    expect(player.events).toEqual(["speak@0", "done@3000", "play@3000"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await done).startedTrack).toBe(true);
    expect(player.volume).toBe(80);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.events.filter((e) => e.startsWith("play"))).toHaveLength(1);
  });

  it("stops talking and restores the volume when aborted mid-speech", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 0 });
    const v = voice(player, 5000);
    const abort = new AbortController();
    const done = runSegment(plan({ mode: "overIntro" }), { player, speak: v.speak, ducking, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort();
    expect(await done).toMatchObject({ cancelled: true, spoke: false });
    expect(v.aborted).toBe(true);
    expect(player.volume).toBe(80);
  });

  it("still starts the track when an intro is skipped, but not for a back-announcement", async () => {
    const player = new FakePlayer(80);
    const ducking = new DuckingController(player, { rampMs: 0 });
    const v = voice(player, 1000);
    expect(await runSegment(plan({ mode: "skip", kind: "micro" }), { player, speak: v.speak, ducking })).toMatchObject({ startedTrack: true, spoke: false });
    const other = new FakePlayer(80);
    expect(await runSegment(plan({ mode: "skip", kind: "back" }), { player: other, speak: v.speak, ducking })).toMatchObject({ startedTrack: false });
    expect(v.heard).toEqual([]);
  });
});
