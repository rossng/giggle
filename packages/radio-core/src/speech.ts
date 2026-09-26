/**
 * How long a line takes to say. A deliberately simple model (words per second plus
 * short pauses at punctuation) that's good enough to budget announcements and to
 * schedule them against the music; the app can calibrate `wordsPerSecond` to its voice.
 */

export interface SpeechRate {
  /** Words per second at `rate` 1.0 (default 2.6: an unhurried radio voice). */
  wordsPerSecond: number;
  /** The TTS speed multiplier (default 1.0); 1.2 speaks 20% faster. */
  rate: number;
  /** Extra seconds for each sentence break (". ", ": ", "? "…) inside the text (default 0.3). */
  sentencePause: number;
  /** Extra seconds for each comma (default 0.1). */
  commaPause: number;
}

export const DEFAULT_SPEECH_RATE: SpeechRate = {
  wordsPerSecond: 2.6,
  rate: 1,
  sentencePause: 0.3,
  commaPause: 0.1,
};

/** How many spoken words a token is: "8.30pm" is "eight thirty pm", "1995" three words. */
function tokenWords(token: string): number {
  const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!bare) return 0;
  const digits = bare.replace(/\D/g, "").length;
  // Hyphenated compounds ("twenty-first", "post-rock") take a little longer.
  const parts = bare.split(/[-–]/).filter(Boolean).length;
  let words = Math.max(1, parts);
  if (digits) {
    words = digits === 1 ? 1 : digits === 2 ? 2 : 3;
    const letters = bare.replace(/[\d.:,]/g, "");
    if (letters && letters !== "s") words += 1; // pm, am, th
  } else if (bare.length > 10) {
    words += 0.5;
  }
  return words;
}

/** Estimated seconds to say `text`, to one decimal place. */
export function estimateSeconds(text: string, rate: Partial<SpeechRate> = {}): number {
  const r = { ...DEFAULT_SPEECH_RATE, ...rate };
  const speed = r.rate > 0 && Number.isFinite(r.rate) ? r.rate : 1;
  const wps = r.wordsPerSecond > 0 && Number.isFinite(r.wordsPerSecond) ? r.wordsPerSecond : 2.6;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let words = 0;
  for (const token of trimmed.split(/\s+/)) words += tokenWords(token);
  const breaks = (trimmed.match(/[.!?:;](?=\s)/g) ?? []).length;
  const commas = (trimmed.match(/,(?=\s)/g) ?? []).length;
  const seconds = (words / wps + breaks * r.sentencePause + commas * r.commaPause) / speed;
  return Math.round(seconds * 10) / 10;
}
