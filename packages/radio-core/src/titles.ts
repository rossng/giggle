/**
 * Song titles as a presenter would say them: without "(feat. …)", "[Official Video]",
 * "- Remastered 2011", "(12" Version)", "(Deluxe Edition)" and the like. Meaningful parts
 * such as "(Reprise)", "(Acoustic)" or "(Bicep Remix)" stay.
 */

/** Credits and video noise: the whole bracket goes, whatever follows the word. */
const NOISE_WORDS = [
  "feat\\.?",
  "ft\\.?",
  "featuring",
  "with",
  "prod\\.?",
  "produced by",
  "official",
  "lyrics?",
  "audio",
  "video",
  "music video",
  "visuali[sz]er",
  "live",
  "ao vivo",
  "en vivo",
  "en directo",
  "hd",
  "hq",
  "4k",
  "m/?v",
  "clip officiel",
  "videoclip",
  "a colors (?:show|encore)",
].join("|");

/** "(feat. X)", "[Official Video]", "(Live at Paradiso)", "【MV】"… anywhere in the title. */
const BRACKETED = new RegExp(`\\s*[(\\[【]\\s*(?:${NOISE_WORDS})(?![\\p{L}\\p{N}])[^)\\]】]*[)\\]】]`, "giu");

const YEAR = "(?:19|20)\\d{2}";

/** Words that only say which release or format a recording comes from. */
const RELEASE_WORD = [
  YEAR,
  "\\d{1,2}(?:\\s*(?:\"|”|″|'')|\\s*-?\\s*inch(?:es)?|in\\.?)", // 12", 7-inch, 12in
  "\\d{1,2}(?:st|nd|rd|th)?",
  "digital",
  "original",
  "radio",
  "single",
  "album",
  "lp",
  "ep",
  "extended",
  "long",
  "short",
  "full(?:[- ]length)?",
  "club",
  "studio",
  "new",
  "deluxe",
  "expanded",
  "anniversary",
  "special",
  "limited",
  "alt\\.?",
  "alternate",
  "alternative",
  "[ab][- ]?side",
  "vinyl",
  "bonus",
  "mono",
  "stereo",
  "explicit",
  "clean",
  "remaster(?:ed)?",
].join("|");

/** What such a phrase is about: "… Version", "… Edit", "… Mix", "Mono", "Bonus Track"… */
const RELEASE_HEAD = [
  "version",
  "edit",
  "mix",
  "mixed",
  "cut",
  "take",
  "mono",
  "stereo",
  "explicit",
  "clean",
  "studio",
  "remaster(?:ed|ing)?",
  "edition",
  "re-?record(?:ed|ing)?",
  "bonus track",
].join("|");

/** "12\" Version", "Original Single Mix", "2022 Remastered Edition", "Version 1992", "Mono". */
const RELEASE_PHRASE = `(?:(?:${RELEASE_WORD})[\\s-]+)*(?:${RELEASE_HEAD})(?:\\s+(?:${RELEASE_WORD}|${RELEASE_HEAD}))*`;

/** A bracket holding only such a phrase. Named ones ("(Bicep Remix)", "(HUTS Edit)",
 * "(Bachata Version)") are other recordings and stay. */
const BRACKETED_RELEASE = new RegExp(`\\s*[(\\[]\\s*${RELEASE_PHRASE}\\s*[)\\]]`, "giu");

/** Remasters, editions and bonus tracks are never another recording, so any bracket that
 * mentions one goes: "(2001 Digital Remaster)", "(Graveside Edition)", "(Japan Bonus Track)". */
const BRACKETED_EDITION =
  /\s*[(\[][^)\]]*(?<![\p{L}\p{N}])(?:remaster(?:ed|ing)?|edition|bonus track)(?![\p{L}\p{N}])[^)\]]*[)\]]/giu;

/** Where the song comes from: "(From "Barbie The Album")", "(from the Netflix Series "X")",
 * "[Apple TV+ Original Series Soundtrack]", "(Single from Pachinko: Season 1)". */
const BRACKETED_SOURCE =
  /\s*[(\[](?:[^)\]]*(?<![\p{L}\p{N}])soundtrack(?![\p{L}\p{N}])|single\s+from\s|from\s+(?:the\s+)?(?:["“'‘]|(?:netflix|disney|amazon|apple|hbo|motion\s+picture|film|movie|tv|television|series|musical|video\s+game|anime|original)(?![\p{L}\p{N}])))[^)\]]*[)\]]/giu;

/** A credit after something else in the bracket: "(X Remix; feat. Y)" → "(X Remix)". */
const INNER_FEAT = /\s*[;,]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*(?=[)\]])/giu;

/** "Song feat. X" without brackets: everything from the feat onwards. */
const LOOSE_FEAT = /\s+(?:feat\.|ft\.|featuring)\s.*$/iu;

/** "Song - Remastered 2011", "Song - Live at Paradiso", "Song | Official Video", "Song - EP Version"… */
const DASH_SUFFIX = new RegExp(
  `\\s+[-–—|]\\s+(?:${RELEASE_PHRASE}|(?:live|ao vivo|en vivo|en directo)(?:\\s+(?:at|from|in|on)\\s.*)?|(?:official\\s+)?(?:music\\s+)?video|official audio|audio|lyrics?(?:\\s+video)?|visuali[sz]er|a colors (?:show|encore))\\s*$`,
  "iu",
);

const QUOTED = /^["“”'‘’](.+)["“”'’]$/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The title to say out loud. Pass the artist's name to also strip a leading
 * "Artist - " (common in YouTube video titles). Never returns an empty string for
 * a non-empty title: if cleaning would remove everything, the original is kept.
 */
export function cleanSongTitle(title: string | null | undefined, artistName?: string): string {
  const original = (title ?? "").replace(/\s+/g, " ").trim();
  let t = original;
  if (artistName?.trim()) {
    const prefix = new RegExp(`^${escapeRegExp(artistName.trim())}\\s*[-–—:]\\s+`, "iu");
    t = t.replace(prefix, "");
  }
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t
      .replace(BRACKETED, "")
      .replace(INNER_FEAT, "")
      .replace(BRACKETED_RELEASE, "")
      .replace(BRACKETED_EDITION, "")
      .replace(BRACKETED_SOURCE, "")
      .replace(LOOSE_FEAT, "")
      .replace(DASH_SUFFIX, "");
    t = t.replace(/\s+/g, " ").replace(/\s*[-–—|:]\s*$/u, "").trim();
    const quoted = QUOTED.exec(t);
    if (quoted?.[1]) t = quoted[1].trim();
    if (t === before) break;
  }
  return t || original;
}
