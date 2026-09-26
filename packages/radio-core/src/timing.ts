/**
 * When to speak, relative to the music, the way a DJ would:
 *
 * - `backAnnounce`: over the outro of the track that's finishing, ducked, timed to
 *   end `outroMarginSeconds` before the track does.
 * - `overIntro`: short lines over the first seconds of the next track, ducked.
 * - `beforeTrack`: longer lines with the music at zero; the next track starts
 *   `leadInSeconds` before the speech is expected to end, comes up under the last
 *   words and fades in fully once the talking stops ("talking up to the vocal").
 * - `skip`: say nothing (voice off, a back-announcement after a skip, a
 *   micro-announcement too soon after the last line…). The track still starts.
 *
 * `planSegment` is pure and returns a declarative plan; `runSegment` carries one out
 * with the app's Player, speech function and DuckingController.
 */

import type { VoiceMode } from "./announcer.ts";
import type { DuckingController, Speak, Timers } from "./ducking.ts";
import type { LineKind } from "./presenter.ts";
import type { Player } from "./types.ts";

export type SegmentMode = "backAnnounce" | "overIntro" | "beforeTrack" | "skip";

export interface TimingOptions {
  /** Back-announcements finish this long before the track ends (default 1.5 s). */
  outroMarginSeconds: number;
  /** Only back-announce tracks at least this long (default 60 s). */
  minBackTrackSeconds: number;
  /** Lines up to this long are said over the next track's intro (default 6 s). */
  overIntroMaxSeconds: number;
  /** In `beforeTrack`, the next track starts this long before the speech ends (default 1 s). */
  leadInSeconds: number;
  /** In `beforeTrack`, how long the track takes to come up to full volume (default 1.5 s). */
  fadeInSeconds: number;
  /** Music volume under speech (default 20). */
  duckTo: number;
  /** Micro-announcements are skipped this soon after the previous line ended (default 30 s). */
  microMinGapSeconds: number;
}

export const DEFAULT_TIMING: TimingOptions = {
  outroMarginSeconds: 1.5,
  minBackTrackSeconds: 60,
  overIntroMaxSeconds: 6,
  leadInSeconds: 1,
  fadeInSeconds: 1.5,
  duckTo: 20,
  microMinGapSeconds: 30,
};

export interface SegmentInput {
  /** What's to be said: its kind and estimated length (a presenter `Line` fits). */
  line: { kind: LineKind; seconds: number; mode?: "name" | "short" } | null;
  voice: VoiceMode;
  /** For back-announcements: the track that's finishing. */
  finishing?: { durationSeconds?: number | null; skipped?: boolean };
  /** Seconds since the last line finished (undefined: nothing said yet). */
  sinceLastSpeechSeconds?: number;
  options?: Partial<TimingOptions>;
}

export interface SegmentPlan {
  mode: SegmentMode;
  kind: LineKind | null;
  speechSeconds: number;
  /**
   * When to start speaking, in seconds: into the finishing track for `backAnnounce`,
   * into the next track for `overIntro`; 0 for `beforeTrack` (straight away).
   */
  startAt: number;
  /** Music volume while speaking (0 in `beforeTrack`: silence before the track). */
  duckTo: number;
  /** `beforeTrack`: the track starts this long before the speech ends; else 0. */
  leadInSeconds: number;
  /** `beforeTrack`: the track comes up to `duckTo`-under-speech level… */
  leadInVolume: number;
  /** …then to full volume over this long once speech ends. 0 elsewhere. */
  fadeInSeconds: number;
  /** Why it was skipped. */
  reason?: string;
}

function skip(kind: LineKind | null, reason: string, speechSeconds = 0): SegmentPlan {
  return {
    mode: "skip",
    kind,
    speechSeconds,
    startAt: 0,
    duckTo: 100,
    leadInSeconds: 0,
    leadInVolume: 100,
    fadeInSeconds: 0,
    reason,
  };
}

/** Decides how to schedule a line against the music. Pure. */
export function planSegment(input: SegmentInput): SegmentPlan {
  const o = { ...DEFAULT_TIMING, ...input.options };
  const line = input.line;
  if (input.voice === "off") return skip(line?.kind ?? null, "voice off");
  if (!line) return skip(null, "nothing to say");
  const seconds = Math.max(0, Number.isFinite(line.seconds) ? line.seconds : 0);
  const base = { kind: line.kind, speechSeconds: seconds, leadInVolume: o.duckTo, fadeInSeconds: 0 };

  if (line.kind === "back") {
    const duration = input.finishing?.durationSeconds;
    if (input.finishing?.skipped) return skip("back", "track was skipped", seconds);
    if (typeof duration !== "number" || !Number.isFinite(duration)) return skip("back", "duration unknown", seconds);
    if (duration <= o.minBackTrackSeconds) return skip("back", "track too short", seconds);
    const startAt = Math.max(0, duration - seconds - o.outroMarginSeconds);
    return { ...base, mode: "backAnnounce", startAt, duckTo: o.duckTo, leadInSeconds: 0 };
  }

  if (line.kind === "micro") {
    const since = input.sinceLastSpeechSeconds;
    if (since !== undefined && since < o.microMinGapSeconds) return skip("micro", "spoke too recently", seconds);
    return { ...base, mode: "overIntro", startAt: 0, duckTo: o.duckTo, leadInSeconds: 0 };
  }

  // A new-artist link. "Name" mode is always short and said over the intro.
  if (input.voice === "name" || line.mode === "name" || seconds <= o.overIntroMaxSeconds) {
    return { ...base, mode: "overIntro", startAt: 0, duckTo: o.duckTo, leadInSeconds: 0 };
  }
  return {
    ...base,
    mode: "beforeTrack",
    startAt: 0,
    duckTo: 0,
    leadInSeconds: Math.min(o.leadInSeconds, seconds / 2),
    fadeInSeconds: o.fadeInSeconds,
  };
}

// ---------- executor ----------

export interface SegmentContext {
  player: Pick<Player, "play">;
  /** Says the line; should stop early (and resolve) when `signal` aborts. */
  speak: Speak<unknown>;
  ducking: DuckingController;
  timers?: Timers;
  /** Starts the next track (overIntro, beforeTrack, skip). Default: `player.play()`. */
  startTrack?: () => void | Promise<void>;
  /** backAnnounce: where the finishing track is now, in seconds (default 0). */
  positionSeconds?: number;
  /** Aborting cancels a pending segment, or stops the speech and restores the volume. */
  signal?: AbortSignal;
}

export interface SegmentResult {
  spoke: boolean;
  startedTrack: boolean;
  cancelled: boolean;
}

const defaultTimers: Timers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Resolves after `ms`, or false straight away if `signal` aborts first. */
function wait(ms: number, timers: Timers, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      timers.clearTimeout(handle);
      resolve(false);
    };
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Carries out a plan from `planSegment`. */
export async function runSegment(plan: SegmentPlan, ctx: SegmentContext): Promise<SegmentResult> {
  const timers = ctx.timers ?? defaultTimers;
  const signal = ctx.signal;
  const result: SegmentResult = { spoke: false, startedTrack: false, cancelled: false };
  const start = async (): Promise<void> => {
    if (result.startedTrack) return;
    result.startedTrack = true;
    await (ctx.startTrack ? ctx.startTrack() : ctx.player.play());
  };
  const cancelled = (): SegmentResult => ({ ...result, cancelled: true });
  if (signal?.aborted) return cancelled();

  // Abort mid-speech: stop talking and put the volume straight back.
  let speaking = false;
  const onAbort = (): void => {
    if (speaking) ctx.ducking.cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const speak = async (s: AbortSignal): Promise<void> => {
    speaking = true;
    try {
      await ctx.speak(s);
      result.spoke = !signal?.aborted && !s.aborted;
    } finally {
      speaking = false;
    }
  };

  try {
    switch (plan.mode) {
      case "skip":
        if (plan.kind !== "back") await start();
        return result;

      case "backAnnounce": {
        const delay = (plan.startAt - (ctx.positionSeconds ?? 0)) * 1000;
        if (!(await wait(delay, timers, signal))) return cancelled();
        await ctx.ducking.duck(speak, { duckTo: plan.duckTo });
        break;
      }

      case "overIntro":
        // Duck first (the old track has ended, so this is silent), then start the
        // new one under the voice.
        await ctx.ducking.duck(async (s) => {
          await start();
          if (!(await wait(plan.startAt * 1000, timers, s))) return;
          await speak(s);
        }, { duckTo: plan.duckTo });
        break;

      case "beforeTrack":
        await ctx.ducking.duck(
          async (s) => {
            const leadInAt = Math.max(0, plan.speechSeconds - plan.leadInSeconds) * 1000;
            const leadIn = new AbortController();
            s.addEventListener("abort", () => leadIn.abort(), { once: true });
            const cue = wait(leadInAt, timers, leadIn.signal).then(async (due) => {
              if (!due) return;
              await start();
              await ctx.ducking.level(plan.leadInVolume, Math.min(plan.leadInSeconds * 1000, 500));
            });
            await speak(s);
            leadIn.abort(); // speech ended before the cue: start now, then fade in
            await cue;
            if (!s.aborted) await start();
          },
          { duckTo: plan.duckTo, restoreMs: plan.fadeInSeconds * 1000 },
        );
        break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return signal?.aborted ? cancelled() : result;
}
