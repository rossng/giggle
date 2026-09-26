/**
 * Data shapes shared with the pipeline (`data/site/gigs.json`, `artists.json`) and the
 * app. Field names follow the pipeline's JSON exactly (snake_case included), so the
 * files can be typed with a plain cast after `JSON.parse`.
 */

/** Ticket availability, as podia's `Availability`. */
export type Availability =
  | "unknown"
  | "on_sale"
  | "few_left"
  | "sold_out"
  | "free"
  | "not_yet_on_sale";

/** Event status, as podia's `Status`. */
export type GigStatus = "scheduled" | "cancelled" | "postponed" | "moved";

/** What kind of event the line-up step decided a gig is. */
export type LineupKind = "concert" | "festival" | "club" | "tribute" | "not_music";

export interface Price {
  min_eur: number | null;
  max_eur: number | null;
  /** The venue's own wording, when it isn't a plain number. */
  text?: string | null;
}

export interface Lineup {
  kind: LineupKind;
  headliners: string[];
  support: string[];
  /** Which model (or "rules") produced it. */
  source?: string;
}

export type ArtistRole = "headliner" | "support";

/** An artist on a gig's bill: a reference into `artists.json` by `key`. */
export interface GigArtist {
  key: string;
  name: string;
  role: ArtistRole;
}

export interface Gig {
  /** `<venue>:<source_id>`, unique and stable across runs. */
  id: string;
  venue: string;
  title: string;
  /** ISO 8601 with offset, e.g. `2026-10-16T20:30:00+02:00`. */
  start: string;
  city: string | null;
  status: GigStatus;
  availability: Availability;
  price: Price | null;
  lineup: Lineup;
  artists: GigArtist[];
  place?: string;
  source_id?: string;
  url?: string | null;
  subtitle?: string | null;
  doors?: string | null;
  end?: string | null;
  room?: string | null;
  performers?: string[];
  support?: string[];
  genres?: string[];
  categories?: string[];
  ticket_url?: string | null;
  description?: string | null;
  image?: string | null;
  extra?: Record<string, unknown>;
}

export interface Venue {
  slug: string;
  name: string;
  city: string;
  website: string;
  country: string;
}

/** `data/site/gigs.json`. */
export interface GigsFile {
  generated: string;
  since: string;
  venues: Record<string, Venue>;
  gigs: Gig[];
}

export interface MusicBrainzMatch {
  mbid: string;
  name: string;
  disambiguation: string | null;
  namesakes: number;
  confidence: "high" | "medium" | "low";
}

export interface MusicBrainzDetails {
  mbid: string;
  name: string | null;
  type: string | null;
  country: string | null;
  area: string | null;
  begin_area: string | null;
  begin: string | null;
  ended: boolean | null;
  genres: string[];
  tags: string[];
  links: Record<string, string>;
}

export interface LastfmInfo {
  name: string | null;
  mbid: string | null;
  url: string | null;
  listeners: number;
  playcount: number;
  tags: string[];
  similar: string[];
  bio: string | null;
}

export interface LastfmTrack {
  title: string | null;
  listeners: number;
  playcount: number;
}

export interface WikipediaSummary {
  title: string | null;
  lang: string;
  description: string | null;
  extract: string;
  url: string | null;
  thumbnail: string | null;
}

/** One record of `data/site/artists.json`. */
export interface Artist {
  /** `mb:<mbid>` when matched on MusicBrainz, otherwise `name:<normalised name>`. */
  key: string;
  name: string;
  match: MusicBrainzMatch | null;
  musicbrainz: MusicBrainzDetails | null;
  lastfm: LastfmInfo | null;
  top_tracks: LastfmTrack[] | null;
  wikipedia: WikipediaSummary | null;
  /** Gig ids, soonest first. */
  gigs: string[];
}

/** `data/site/artists.json`. */
export interface ArtistsFile {
  artists: Record<string, Artist>;
}

/**
 * Something playable. Source-agnostic: `videoId` is the id the app's Player
 * understands (a YouTube video id today; it could be a Spotify URI later).
 */
export interface Track {
  videoId: string;
  title: string;
  album?: string;
}

export type Unsubscribe = () => void;

export interface PlayerError {
  /** Source-specific code, e.g. YouTube's 101/150 for "embedding disabled". */
  code?: number | string;
  message?: string;
}

/**
 * What the radio needs from a media player. Implementations (YouTube IFrame, later
 * Spotify) live in the app. Volume is 0–100.
 */
export interface Player {
  load(track: Track): void | Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  getVolume(): number;
  onEnded(callback: () => void): Unsubscribe;
  onError(callback: (error: PlayerError) => void): Unsubscribe;
  onPlaying(callback: () => void): Unsubscribe;
}
