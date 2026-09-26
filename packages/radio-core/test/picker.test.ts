import { describe, expect, it } from "vitest";
import { PhrasePicker, type Template } from "../src/picker.ts";
import { mulberry32 } from "../src/random.ts";

describe("PhrasePicker.pick", () => {
  it("never repeats the previous choice for a slot", () => {
    const p = new PhrasePicker(mulberry32(1));
    let last = "";
    for (let i = 0; i < 500; i++) {
      const x = p.pick("s", ["a", "b", "c"]);
      expect(x).not.toBe(last);
      last = x;
    }
  });

  it("tracks slots independently", () => {
    // With rng always 0, the first fresh option is chosen.
    const p = new PhrasePicker(() => 0);
    expect(p.pick("one", ["a", "b"])).toBe("a");
    expect(p.pick("two", ["a", "b"])).toBe("a");
    expect(p.pick("one", ["a", "b"])).toBe("b");
    expect(p.pick("two", ["a", "b"])).toBe("b");
  });

  it("repeats when there's only one option", () => {
    const p = new PhrasePicker(mulberry32(2));
    expect(p.pick("s", ["only"])).toBe("only");
    expect(p.pick("s", ["only"])).toBe("only");
  });

  it("uses every option eventually", () => {
    const p = new PhrasePicker(mulberry32(3));
    const seen = new Set(Array.from({ length: 200 }, () => p.pick("s", ["a", "b", "c", "d", "e"])));
    expect(seen.size).toBe(5);
  });

  it("copes with an rng returning values near 1", () => {
    const p = new PhrasePicker(() => 0.999999999);
    expect(["a", "b", "c"]).toContain(p.pick("s", ["a", "b", "c"]));
  });

  it("throws on an empty list", () => {
    expect(() => new PhrasePicker(Math.random).pick("s", [])).toThrow();
  });

  it("is deterministic for a seeded rng, and resettable", () => {
    const run = () => {
      const p = new PhrasePicker(mulberry32(9));
      return Array.from({ length: 30 }, () => p.pick("s", ["a", "b", "c", "d"]));
    };
    expect(run()).toEqual(run());
    const p = new PhrasePicker(() => 0);
    p.pick("s", ["a", "b"]);
    expect(p.last("s")).toBe(0);
    p.reset();
    expect(p.last("s")).toBeUndefined();
  });
});

describe("PhrasePicker.render", () => {
  type C = { name: string; song: string | null };
  const templates: Template<C>[] = [
    (c) => `This is ${c.name}.`,
    (c) => c.song && `Here's ${c.song}.`,
    (c) => `Next, ${c.name}.`,
  ];

  it("only uses templates that fit", () => {
    const p = new PhrasePicker(mulberry32(4));
    for (let i = 0; i < 100; i++) {
      expect(p.render("s", templates, { name: "X", song: null })).not.toMatch(/Here's|null/);
    }
  });

  it("never repeats the previous template, even as the text changes", () => {
    const p = new PhrasePicker(mulberry32(5));
    let last = -1;
    for (let i = 0; i < 300; i++) {
      p.render("s", templates, { name: `N${i}`, song: `S${i}` });
      const now = p.last("s")!;
      expect(now).not.toBe(last);
      last = now;
    }
  });

  it("returns empty when nothing fits", () => {
    const p = new PhrasePicker(mulberry32(6));
    expect(p.render("s", [() => null, () => false, () => ""], {})).toBe("");
  });
});
