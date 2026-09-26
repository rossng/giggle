/**
 * Volume ducking under announcements: fade the music down, speak, fade back up.
 *
 * Overlapping announcements are safe. A new `duck` aborts the previous speech (via
 * its AbortSignal), takes over, and only the newest one fades back up, to the
 * volume from before the first of them. The volume is never left low.
 */

import type { Player } from "./types.ts";

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DuckingOptions {
  /** Volume while speaking, 0–100 (default 20). Never raises a quieter volume. */
  duckTo?: number;
  /** Fade length in ms (default 300). */
  rampMs?: number;
  /** Volume steps per fade (default 6). */
  steps?: number;
  /** Timer functions; defaults to the global ones. Inject fakes in tests. */
  timers?: Timers;
}

/** Per-announcement overrides for `duck`. */
export interface DuckOptions {
  /** Volume while speaking, 0–100, instead of the controller's (0 = music paused). */
  duckTo?: number;
  /** Fade-back length in ms instead of the controller's `rampMs` (a slower fade-in). */
  restoreMs?: number;
}

/** Speaks, resolving when done. Should stop early (and resolve) when `signal` aborts. */
export type Speak<T> = (signal: AbortSignal) => Promise<T>;

const defaultTimers: Timers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 100;
}

interface Ramp {
  handle: unknown;
  finish: () => void;
}

export class DuckingController {
  readonly #player: Pick<Player, "getVolume" | "setVolume">;
  readonly #duckTo: number;
  readonly #rampMs: number;
  readonly #steps: number;
  readonly #timers: Timers;
  /** The volume to come back to; null when not ducked. */
  #base: number | null = null;
  #generation = 0;
  #abort: AbortController | null = null;
  #ramp: Ramp | null = null;

  constructor(player: Pick<Player, "getVolume" | "setVolume">, options: DuckingOptions = {}) {
    this.#player = player;
    this.#duckTo = clampVolume(options.duckTo ?? 20);
    this.#rampMs = Math.max(0, options.rampMs ?? 300);
    this.#steps = Math.max(1, Math.floor(options.steps ?? 6));
    this.#timers = options.timers ?? defaultTimers;
  }

  /** Whether the music is (or is about to be) ducked, or fading back. */
  get ducked(): boolean {
    return this.#base !== null;
  }

  /** The listener's volume: what ducking returns to. */
  get volume(): number {
    return this.#base ?? clampVolume(this.#player.getVolume());
  }

  /**
   * Sets the listener's volume. While ducked it becomes the volume to return to;
   * otherwise it's applied straight away.
   */
  setVolume(volume: number): void {
    const v = clampVolume(volume);
    if (this.#base !== null) this.#base = v;
    else this.#player.setVolume(v);
  }

  /**
   * Fades down, runs `speak`, fades back up. Resolves with what `speak` returned, or
   * undefined if a newer announcement took over before this one started speaking.
   * If `speak` rejects, the volume is still restored and the error rethrown.
   */
  async duck<T>(speak: Speak<T>, options: DuckOptions = {}): Promise<T | undefined> {
    const generation = ++this.#generation;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    if (this.#base === null) this.#base = clampVolume(this.#player.getVolume());
    const duckTo = clampVolume(options.duckTo ?? this.#duckTo);
    const restoreMs = Math.max(0, options.restoreMs ?? this.#rampMs);

    await this.#rampTo(Math.min(duckTo, this.#base));
    if (generation !== this.#generation) return undefined;
    try {
      return await speak(abort.signal);
    } finally {
      if (generation === this.#generation) await this.#restore(generation, restoreMs);
    }
  }

  /**
   * While ducked, fades the music to `volume` (never above the listener's volume),
   * e.g. bringing a track up under the last words of an announcement. The fade back
   * after speaking still goes to the listener's volume. No-op when not ducked.
   */
  async level(volume: number, rampMs: number = this.#rampMs): Promise<void> {
    if (this.#base === null) return;
    await this.#rampTo(Math.min(clampVolume(volume), this.#base), rampMs);
  }

  /** Stops any announcement at once and puts the volume straight back. */
  cancel(): void {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#stopRamp();
    if (this.#base !== null) {
      this.#player.setVolume(this.#base);
      this.#base = null;
    }
  }

  async #restore(generation: number, rampMs: number): Promise<void> {
    this.#abort = null;
    await this.#rampTo(this.#base ?? this.volume, rampMs);
    if (generation !== this.#generation || this.#base === null) return;
    // The listener may have changed the volume during the fade.
    if (clampVolume(this.#player.getVolume()) !== this.#base) this.#player.setVolume(this.#base);
    this.#base = null;
  }

  #stopRamp(): void {
    const ramp = this.#ramp;
    if (!ramp) return;
    this.#ramp = null;
    this.#timers.clearTimeout(ramp.handle);
    ramp.finish();
  }

  /** Fades to `target`; a newer fade cuts this one short (resolving it). */
  #rampTo(target: number, rampMs: number = this.#rampMs): Promise<void> {
    this.#stopRamp();
    const from = clampVolume(this.#player.getVolume());
    const to = clampVolume(target);
    if (from === to) return Promise.resolve();
    if (rampMs === 0) {
      this.#player.setVolume(to);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let step = 0;
      const ramp: Ramp = { handle: undefined, finish: resolve };
      const tick = (): void => {
        step++;
        this.#player.setVolume(Math.round(from + ((to - from) * step) / this.#steps));
        if (step >= this.#steps) {
          if (this.#ramp === ramp) this.#ramp = null;
          resolve();
        } else {
          ramp.handle = this.#timers.setTimeout(tick, rampMs / this.#steps);
        }
      };
      ramp.handle = this.#timers.setTimeout(tick, rampMs / this.#steps);
      this.#ramp = ramp;
    });
  }
}
