import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckingController, type Timers } from "../src/ducking.ts";

class FakePlayer {
  volume: number;
  readonly log: number[] = [];
  constructor(volume = 100) {
    this.volume = volume;
  }
  getVolume(): number {
    return this.volume;
  }
  setVolume(v: number): void {
    this.volume = v;
    this.log.push(v);
  }
}

/** A speech that finishes when told to, or when aborted. */
function speech() {
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  const speak = (s: AbortSignal) => {
    signal = s;
    return new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
      s.addEventListener("abort", () => resolve("aborted"));
    });
  };
  return {
    speak,
    finish: (v = "done") => finish(v),
    fail: (e: Error) => fail(e),
    get signal() {
      return signal;
    },
    get started() {
      return signal !== undefined;
    },
  };
}

describe("DuckingController (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ramps down to 20 over ~300 ms, speaks, and ramps back", async () => {
    const player = new FakePlayer(80);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak);

    expect(s.started).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(player.volume).toBeGreaterThan(20);
    expect(player.volume).toBeLessThan(80);
    await vi.advanceTimersByTimeAsync(150);
    expect(player.volume).toBe(20);
    expect(s.started).toBe(true);
    expect(duck.ducked).toBe(true);

    await vi.advanceTimersByTimeAsync(5000); // speaking
    expect(player.volume).toBe(20);

    s.finish();
    await vi.advanceTimersByTimeAsync(300);
    expect(await done).toBe("done");
    expect(player.volume).toBe(80);
    expect(duck.ducked).toBe(false);
    expect(player.log).toEqual([70, 60, 50, 40, 30, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("never raises a volume that's already quiet", async () => {
    const player = new FakePlayer(10);
    const duck = new DuckingController(player);
    const done = duck.duck(async () => "ok");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBe("ok");
    expect(player.log).toEqual([]);
    expect(player.volume).toBe(10);
  });

  it("restores the volume when speech fails, and rethrows", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak);
    const caught = done.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(300);
    s.fail(new Error("no voice"));
    await vi.advanceTimersByTimeAsync(300);
    expect(await caught).toBe("no voice");
    expect(player.volume).toBe(100);
  });

  it("lets a new announcement take over one that's speaking", async () => {
    const player = new FakePlayer(90);
    const duck = new DuckingController(player);
    const first = speech();
    const second = speech();
    const d1 = duck.duck(first.speak);
    await vi.advanceTimersByTimeAsync(300);
    expect(first.started).toBe(true);

    const d2 = duck.duck(second.speak);
    expect(first.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(await d1).toBe("aborted");
    expect(player.volume).toBe(20); // the first one didn't ramp back up
    expect(second.started).toBe(true);

    second.finish();
    await vi.advanceTimersByTimeAsync(300);
    expect(await d2).toBe("done");
    expect(player.volume).toBe(90);
    expect(player.log.filter((v) => v > 20 && v < 90).length).toBe(10); // one fade down, one up
  });

  it("returns undefined for an announcement superseded while fading down", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player);
    const first = speech();
    const second = speech();
    const d1 = duck.duck(first.speak);
    await vi.advanceTimersByTimeAsync(100);
    const d2 = duck.duck(second.speak);
    await vi.advanceTimersByTimeAsync(300);
    expect(await d1).toBeUndefined();
    expect(first.started).toBe(false);
    expect(second.started).toBe(true);
    second.finish();
    await vi.advanceTimersByTimeAsync(300);
    await d2;
    expect(player.volume).toBe(100);
  });

  it("returns to the original volume when interrupted while fading back up", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player);
    const first = speech();
    const second = speech();
    const d1 = duck.duck(first.speak);
    await vi.advanceTimersByTimeAsync(300);
    first.finish();
    await vi.advanceTimersByTimeAsync(150); // half-way back up
    expect(player.volume).toBeGreaterThan(20);
    expect(player.volume).toBeLessThan(100);

    const d2 = duck.duck(second.speak);
    await vi.advanceTimersByTimeAsync(300);
    expect(await d1).toBe("done");
    expect(player.volume).toBe(20);
    second.finish();
    await vi.advanceTimersByTimeAsync(300);
    await d2;
    expect(player.volume).toBe(100);
    expect(duck.ducked).toBe(false);
  });

  it("survives a burst of overlapping announcements", async () => {
    const player = new FakePlayer(75);
    const duck = new DuckingController(player);
    const speeches = Array.from({ length: 6 }, () => speech());
    const all = speeches.map((s, i) => {
      const p = duck.duck(s.speak);
      void vi.advanceTimersByTimeAsync(40 * i);
      return p;
    });
    await vi.advanceTimersByTimeAsync(1000);
    speeches.at(-1)!.finish();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);
    expect(player.volume).toBe(75);
    expect(duck.ducked).toBe(false);
    expect(Math.max(...player.log)).toBeLessThanOrEqual(75);
  });

  it("treats volume changes while ducked as the volume to return to", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak);
    await vi.advanceTimersByTimeAsync(300);
    duck.setVolume(60);
    expect(player.volume).toBe(20);
    expect(duck.volume).toBe(60);
    s.finish();
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(player.volume).toBe(60);
  });

  it("also honours a volume change during the fade back up", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak);
    await vi.advanceTimersByTimeAsync(300);
    s.finish();
    await vi.advanceTimersByTimeAsync(100);
    duck.setVolume(40);
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(player.volume).toBe(40);
  });

  it("applies volume changes straight away when not ducked", () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player);
    duck.setVolume(55.4);
    expect(player.volume).toBe(55);
    duck.setVolume(250);
    expect(player.volume).toBe(100);
    expect(duck.volume).toBe(100);
  });

  it("cancel() stops speech and restores the volume at once", async () => {
    const player = new FakePlayer(70);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak);
    await vi.advanceTimersByTimeAsync(300);
    duck.cancel();
    expect(s.signal?.aborted).toBe(true);
    expect(player.volume).toBe(70);
    expect(duck.ducked).toBe(false);
    expect(await done).toBe("aborted");
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.volume).toBe(70);
  });

  it("cancel() mid-fade leaves the volume where it was", async () => {
    const player = new FakePlayer(70);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak);
    await vi.advanceTimersByTimeAsync(100);
    duck.cancel();
    expect(await done).toBeUndefined();
    expect(s.started).toBe(false);
    expect(player.volume).toBe(70);
  });

  it("takes custom duck level, fade length and steps", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player, { duckTo: 50, rampMs: 100, steps: 2 });
    const done = duck.duck(async () => undefined);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(player.log).toEqual([75, 50, 75, 100]);
  });

  it("jumps straight there with a zero-length fade", async () => {
    const player = new FakePlayer(100);
    const duck = new DuckingController(player, { rampMs: 0 });
    let during = -1;
    await duck.duck(async () => {
      during = player.volume;
    });
    expect(during).toBe(20);
    expect(player.log).toEqual([20, 100]);
  });
});

describe("DuckingController (injected timers)", () => {
  /** A manual clock: nothing happens until `advance`. */
  class ManualTimers implements Timers {
    now = 0;
    #next = 1;
    readonly #queue = new Map<number, { at: number; cb: () => void }>();
    setTimeout(cb: () => void, ms: number): number {
      const id = this.#next++;
      this.#queue.set(id, { at: this.now + ms, cb });
      return id;
    }
    clearTimeout(handle: unknown): void {
      this.#queue.delete(handle as number);
    }
    get pending(): number {
      return this.#queue.size;
    }
    async advance(ms: number): Promise<void> {
      const until = this.now + ms;
      for (;;) {
        await Promise.resolve();
        await Promise.resolve();
        const due = [...this.#queue].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        this.#queue.delete(due[0]);
        this.now = due[1].at;
        due[1].cb();
      }
      this.now = until;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
  }

  it("uses the injected timers, not the global ones", async () => {
    const timers = new ManualTimers();
    const player = new FakePlayer(100);
    const duck = new DuckingController(player, { timers });
    let spoke = false;
    const done = duck.duck(async () => {
      spoke = true;
    });
    expect(timers.pending).toBe(1);
    await timers.advance(299);
    expect(spoke).toBe(false);
    await timers.advance(1);
    expect(spoke).toBe(true);
    await timers.advance(300);
    await done;
    expect(player.volume).toBe(100);
    expect(timers.pending).toBe(0);
  });

  it("clears pending fade timers when superseded", async () => {
    const timers = new ManualTimers();
    const player = new FakePlayer(100);
    const duck = new DuckingController(player, { timers });
    void duck.duck(async () => undefined);
    await timers.advance(100);
    duck.cancel();
    expect(timers.pending).toBe(0);
    expect(player.volume).toBe(100);
  });
});

describe("DuckingController per-announcement options (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("can duck to silence and fade back slowly", async () => {
    const player = new FakePlayer(60);
    const duck = new DuckingController(player);
    const s = speech();
    const done = duck.duck(s.speak, { duckTo: 0, restoreMs: 1200 });
    await vi.advanceTimersByTimeAsync(300);
    expect(player.volume).toBe(0);
    s.finish();
    await vi.advanceTimersByTimeAsync(600);
    expect(player.volume).toBe(30);
    await vi.advanceTimersByTimeAsync(600);
    await done;
    expect(player.volume).toBe(60);
  });

  it("level() brings the music up under the voice without changing the target", async () => {
    const player = new FakePlayer(60);
    const duck = new DuckingController(player, { rampMs: 0 });
    await duck.level(40); // not ducked: nothing happens
    expect(player.volume).toBe(60);
    const s = speech();
    const done = duck.duck(s.speak, { duckTo: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(player.volume).toBe(0);
    await duck.level(20);
    expect(player.volume).toBe(20);
    await duck.level(90); // never above the listener's volume
    expect(player.volume).toBe(60);
    s.finish();
    await done;
    expect(player.volume).toBe(60);
    expect(duck.ducked).toBe(false);
  });
});
