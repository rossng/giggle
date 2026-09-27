/**
 * What radio-core reads of the pipeline's data (`data/site/gigs.json`, `artists.json`): only
 * the fields used here, so the app's full types (web/src/lib/data/types.ts) fit these without
 * casts. Field names follow the JSON (snake_case included).
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

export interface Price {
  min_eur: number | null;
  max_eur: number | null;
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
  /** A key of gigs.json `venues`. */
  venue: string;
  /** ISO 8601 with offset, e.g. `2026-10-16T20:30:00+02:00`. */
  start: string;
  end?: string | null;
  city: string | null;
  status: GigStatus;
  availability: Availability;
  price: Price | null;
  artists: readonly GigArtist[];
}

/** gigs.json `venues[slug]`. */
export interface Venue {
  name: string;
  city: string;
}

/** One record of `artists.json`: the parts the presenter's facts come from. */
export interface Artist {
  name: string;
  musicbrainz: {
    /** "Group", "Person", "Orchestra"… */
    type: string | null;
    /** ISO 3166 code, e.g. "GB". */
    country: string | null;
    area: string | null;
    begin_area?: string | null;
    /** "1995", "1995-04" or "1995-04-01". */
    begin: string | null;
    ended?: boolean | null;
    genres: readonly string[];
    tags: readonly string[];
  } | null;
  lastfm: { tags: readonly string[]; similar: readonly string[] } | null;
  wikipedia: { description: string | null } | null;
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
