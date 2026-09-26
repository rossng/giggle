import { describe, expect, it } from "vitest";
import { DEFAULT_SPEECH_RATE, estimateSeconds } from "../src/speech.ts";

describe("estimateSeconds", () => {
  it("is zero for nothing", () => {
    expect(estimateSeconds("")).toBe(0);
    expect(estimateSeconds("   ")).toBe(0);
  });

  it("defaults to about 2.6 words a second", () => {
    expect(DEFAULT_SPEECH_RATE.wordsPerSecond).toBe(2.6);
    const words = Array.from({ length: 26 }, () => "word").join(" ");
    expect(estimateSeconds(words)).toBe(10);
  });

  it("adds short pauses for sentence breaks and commas", () => {
    const plain = estimateSeconds("here is mike they play paradiso tonight");
    expect(estimateSeconds("Here is Mike. They play Paradiso tonight.")).toBeCloseTo(plain + 0.3, 5);
    expect(estimateSeconds("Here is Mike, they play Paradiso tonight.")).toBeCloseTo(plain + 0.1, 5);
  });

  it("counts times and years as the words they're spoken as", () => {
    // "eight thirty pm" and "nineteen ninety-five" take longer than one word.
    expect(estimateSeconds("at 8.30pm")).toBeGreaterThan(estimateSeconds("at eight"));
    expect(estimateSeconds("since 1995")).toBeCloseTo(4 / 2.6, 1);
  });

  it("is configurable: words per second and TTS rate", () => {
    const text = "This is Mike. They play Paradiso tonight.";
    const base = estimateSeconds(text);
    expect(estimateSeconds(text, { rate: 2 })).toBeCloseTo(base / 2, 1);
    expect(estimateSeconds(text, { wordsPerSecond: 5.2, sentencePause: 0, commaPause: 0 })).toBeCloseTo(7 / 5.2, 1);
    // Nonsense rates fall back to the defaults instead of dividing by zero.
    expect(estimateSeconds(text, { rate: 0, wordsPerSecond: Number.NaN })).toBe(base);
  });
});
