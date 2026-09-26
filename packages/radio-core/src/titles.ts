/**
 * Song titles as a presenter would say them: without "(feat. …)", "[Official Video]",
 * "- Remastered 2011" and the like. Meaningful parts such as "(Reprise)" or
 * "(Bicep Remix)" stay.
 */

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
  "remaster(?:ed)?",
  "\\d{4}\\s+remaster(?:ed)?",
  "\\d{4}\\s+mix",
  "hd",
  "hq",
  "4k",
  "explicit",
  "clean",
  "radio edit",
  "single version",
  "album version",
  "m/?v",
  "clip officiel",
  "videoclip",
].join("|");

/** "(feat. X)", "[Official Video]", "(2011 Remaster)", "【MV】"… anywhere in the title. */
const BRACKETED = new RegExp(`\\s*[(\\[【]\\s*(?:${NOISE_WORDS})(?![\\p{L}\\p{N}])[^)\\]】]*[)\\]】]`, "giu");

/** "Song feat. X" without brackets: everything from the feat onwards. */
const LOOSE_FEAT = /\s+(?:feat\.|ft\.|featuring)\s.*$/iu;

/** "Song - Remastered 2011", "Song - Live at Paradiso", "Song | Official Video"… */
const DASH_SUFFIX =
  /\s+[-–—|]\s+(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|live(?:\s+(?:at|from|in|on)\s.*)?|single version|album version|radio edit|mono|stereo|(?:official\s+)?(?:music\s+)?video|official audio|audio|lyrics?(?:\s+video)?|visuali[sz]er|bonus track)\s*$/iu;

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
    t = t.replace(BRACKETED, "").replace(LOOSE_FEAT, "").replace(DASH_SUFFIX, "");
    t = t.replace(/\s+/g, " ").replace(/\s*[-–—|:]\s*$/u, "").trim();
    const quoted = QUOTED.exec(t);
    if (quoted?.[1]) t = quoted[1].trim();
    if (t === before) break;
  }
  return t || original;
}
