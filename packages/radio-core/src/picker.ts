/**
 * Picks a wording for each part ("slot") of an announcement, never the same one twice
 * in a row for that slot (unless it's the only one that fits).
 */

import type { Rng } from "./random.ts";

/** A wording: returns the text, or a falsy value when it doesn't fit the context. */
export type Template<C> = (ctx: C) => string | null | undefined | false;

export class PhrasePicker {
  readonly #rng: Rng;
  readonly #last = new Map<string, number>();

  constructor(rng: Rng) {
    this.#rng = rng;
  }

  /** One of `options`, uniformly, avoiding the index picked last time for `slot`. */
  pick<T>(slot: string, options: readonly T[]): T {
    if (!options.length) throw new Error(`PhrasePicker: no options for "${slot}"`);
    const index = this.#choose(
      slot,
      options.map((_, i) => i),
    );
    return options[index] as T;
  }

  /**
   * Renders one of the templates that fits `ctx` (returns a non-empty string),
   * avoiding the template used last time for `slot`. Returns "" if none fits.
   * Templates are identified by their index, so keep a slot's list stable.
   */
  render<C>(slot: string, templates: readonly Template<C>[], ctx: C): string {
    const rendered = templates.map((t) => t(ctx));
    const fitting = rendered.flatMap((text, i) => (text ? [i] : []));
    if (!fitting.length) return "";
    return rendered[this.#choose(slot, fitting)] || "";
  }

  /** The index picked last time for `slot`, if any. */
  last(slot: string): number | undefined {
    return this.#last.get(slot);
  }

  reset(): void {
    this.#last.clear();
  }

  #choose(slot: string, candidates: readonly number[]): number {
    const previous = this.#last.get(slot);
    const fresh = candidates.length > 1 ? candidates.filter((i) => i !== previous) : candidates;
    const r = this.#rng();
    const index = fresh[Math.min(fresh.length - 1, Math.floor(r * fresh.length))] ?? 0;
    this.#last.set(slot, index);
    return index;
  }
}
