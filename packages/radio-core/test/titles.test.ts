import { describe, expect, it } from "vitest";
import { cleanSongTitle } from "../src/titles.ts";

describe("cleanSongTitle", () => {
  it.each([
    ["Tidewater (feat. X) [Official Video]", "Tidewater"],
    ["Tidewater (ft. Someone Else)", "Tidewater"],
    ["Tidewater [feat. Someone]", "Tidewater"],
    ["Tidewater (with Lizzo)", "Tidewater"],
    ["Tidewater (Official Music Video)", "Tidewater"],
    ["Tidewater (Official Audio)", "Tidewater"],
    ["Tidewater (Lyric Video)", "Tidewater"],
    ["Tidewater (Lyrics)", "Tidewater"],
    ["Tidewater (Visualizer)", "Tidewater"],
    ["Tidewater (Visualiser)", "Tidewater"],
    ["Tidewater (Live at Paradiso)", "Tidewater"],
    ["Tidewater [HD]", "Tidewater"],
    ["Tidewater (2011 Remaster)", "Tidewater"],
    ["Tidewater (Remastered 2009)", "Tidewater"],
    ["Tidewater (Radio Edit)", "Tidewater"],
    ["Tidewater - Remastered 2011", "Tidewater"],
    ["Tidewater - 2011 Remaster", "Tidewater"],
    ["Tidewater - Remastered", "Tidewater"],
    ["Tidewater – Live at Glastonbury 2019", "Tidewater"],
    ["Tidewater - Live", "Tidewater"],
    ["Tidewater - Single Version", "Tidewater"],
    ["Tidewater | Official Video", "Tidewater"],
    ["Tidewater feat. Someone", "Tidewater"],
    ["Tidewater featuring Someone & Other", "Tidewater"],
    ["Tidewater (feat. A) - Remastered 2011 [Official Video]", "Tidewater"],
    ["“Tidewater”", "Tidewater"],
    ['"Tidewater" (Official Video)', "Tidewater"],
    ["  Tidewater   ", "Tidewater"],
  ])("%s → %s", (raw, clean) => {
    expect(cleanSongTitle(raw)).toBe(clean);
  });

  it.each([
    "Tidewater (Reprise)",
    "Tidewater (Bicep Remix)",
    "Tidewater (Part 2)",
    "Tidewater - Part Two",
    "(I Can't Get No) Satisfaction",
    "Live Forever",
    "Official",
    "Swift Feathers",
    "With or Without You",
    "Video Games",
  ])("keeps %s", (title) => {
    expect(cleanSongTitle(title)).toBe(title);
  });

  it("strips a leading artist name when given", () => {
    expect(cleanSongTitle("Mike - Tidewater (Official Video)", "Mike")).toBe("Tidewater");
    expect(cleanSongTitle("MIKE – Tidewater", "Mike")).toBe("Tidewater");
    expect(cleanSongTitle("Mike: Tidewater", "Mike")).toBe("Tidewater");
    expect(cleanSongTitle("Mikey - Tidewater", "Mike")).toBe("Mikey - Tidewater");
    expect(cleanSongTitle("A+B (C) - Song", "A+B (C)")).toBe("Song");
  });

  it("never returns empty for a non-empty title", () => {
    expect(cleanSongTitle("(Official Video)")).toBe("(Official Video)");
    expect(cleanSongTitle("Mike - ", "Mike")).toBe("Mike");
  });

  it("handles missing titles", () => {
    expect(cleanSongTitle(undefined)).toBe("");
    expect(cleanSongTitle(null)).toBe("");
    expect(cleanSongTitle("")).toBe("");
  });
});
