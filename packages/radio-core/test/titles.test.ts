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
    ['Lucretia My Reflection (12" Version)', "Lucretia My Reflection"],
    ['World Destruction (12" Mix)', "World Destruction"],
    ["World Destruction (12-Inch B Side Version)", "World Destruction"],
    ['Tidewater (7" Edit)', "Tidewater"],
    ["Tidewater (7-inch Version)", "Tidewater"],
    ["Tidewater (Extended Mix)", "Tidewater"],
    ["Tidewater (Extended Version)", "Tidewater"],
    ["Tidewater (Single Edit)", "Tidewater"],
    ["Tidewater (Radio Version)", "Tidewater"],
    ["Tidewater (Original Single Mix)", "Tidewater"],
    ["Tidewater (Long Version)", "Tidewater"],
    ["Tidewater (Studio Version)", "Tidewater"],
    ["Tidewater (Studio)", "Tidewater"],
    ["Tidewater (Version 1992)", "Tidewater"],
    ["Tidewater (2025 Edit)", "Tidewater"],
    ["Tidewater (Alternate Take)", "Tidewater"],
    ["Tidewater (Mono)", "Tidewater"],
    ["Tidewater [Stereo Mix]", "Tidewater"],
    ["Tidewater (Mono Version)", "Tidewater"],
    ["Tidewater (Explicit)", "Tidewater"],
    ["Tidewater (Mixed)", "Tidewater"],
    ["Tidewater (Remastered 2026)", "Tidewater"],
    ["Tidewater (2001 Digital Remaster)", "Tidewater"],
    ["Tidewater (2015 Remastered Version)", "Tidewater"],
    ["Tidewater (Abbey Road Remaster)", "Tidewater"],
    ["Tidewater (Deluxe Edition)", "Tidewater"],
    ["Tidewater (2022 Remastered Edition)", "Tidewater"],
    ["Tidewater (20th Anniversary Edition)", "Tidewater"],
    ["Tidewater (Graveside Edition)", "Tidewater"],
    ["Tidewater (Bonus Track)", "Tidewater"],
    ["Tidewater [Japan Bonus Track]", "Tidewater"],
    ["Tidewater [Live at the Paradiso, 1994]", "Tidewater"],
    ["Tidewater (Ao Vivo)", "Tidewater"],
    ["Tidewater (Live) (Live)", "Tidewater"],
    ['Tidewater (from the Netflix Series "Building The Band") (Live)', "Tidewater"],
    ['Tidewater (From "Fargo Year 2" TV Series Soundtrack)', "Tidewater"],
    ['Tidewater (From "White Album")', "Tidewater"],
    ["Tidewater (Single from Pachinko: Season 1) [Apple TV+ Original Series Soundtrack]", "Tidewater"],
    ["Tidewater - EP Version", "Tidewater"],
    ['Tidewater - 12" Version', "Tidewater"],
    ["Tidewater - Extended Mix", "Tidewater"],
    ["Tidewater - Deluxe Edition", "Tidewater"],
    ["Tidewater - Mono", "Tidewater"],
    ["Tidewater - Bonus Track", "Tidewater"],
    ["Tidewater - 2009 Remastered Version", "Tidewater"],
    ["Tidewater - Re-Recorded", "Tidewater"],
    ["Tidewater - A COLORS SHOW", "Tidewater"],
    ["Tidewater (Skeler Remix) - Re-Recorded", "Tidewater (Skeler Remix)"],
    ["Tidewater (Slayer Cover) (Bonus Track)", "Tidewater (Slayer Cover)"],
    ["Tidewater (Jody Wisternoff Dub Edit (Mixed))", "Tidewater (Jody Wisternoff Dub Edit)"],
    ["Tidewater (Mr. ColliPark Remix; feat. E-40, Bun B)", "Tidewater (Mr. ColliPark Remix)"],
  ])("drops release details: %s → %s", (raw, clean) => {
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
    // Other recordings, named: a presenter would say these.
    "Tidewater (HUTS Edit)",
    "Tidewater (Hex Hector Radio Mix)",
    "Tidewater (Untouchable Mix)",
    "Tidewater (Bachata Version)",
    "Tidewater (Slow Version)",
    "Tidewater (Acoustic)",
    "Tidewater (Acoustic Version)",
    "Tidewater - Acoustic",
    "Tidewater (Instrumental)",
    "Tidewater (Demo)",
    "Tidewater (Remix)",
    "Tidewater (Clean Bandit Remix)",
    "Tidewater (Studio Session)",
    "Tidewater (triple j Like A Version)",
    "Tidewater (Theme from Borderlands)",
    "Tidewater (Version Of Another Song)",
    "Tidewater - ICEE RED EDIT",
    "Final Cut",
    "Take Five",
    "Mono No Aware",
    "(Take My Hand And Let's Go To) The Red Desert",
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
