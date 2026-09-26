// Shapes of the pipeline's output files (data/site/gigs.json and data/site/artists.json).
// Written by hand from pipeline/src/giggle_pipeline (build.py, enrich.py, musicbrainz.py,
// lastfm.py, wikipedia.py) and podia's Event model. Keep in step when those change.
// Anything a venue or lookup might not provide is nullable: adapters don't guess.

/** ISO 8601 date-time with the venue's UTC offset, e.g. "2026-10-03T20:30:00+02:00". */
export type IsoDateTime = string;
/** ISO 8601 calendar date, e.g. "2026-09-26". */
export type IsoDate = string;

export interface Venue {
	slug: string;
	name: string;
	city: string;
	website: string;
	country: string;
}

export type GigStatus = 'scheduled' | 'cancelled' | 'postponed' | 'moved';

export type Availability =
	'unknown' | 'on_sale' | 'few_left' | 'sold_out' | 'free' | 'not_yet_on_sale';

export interface Price {
	min_eur: number | null;
	max_eur: number | null;
	/** The venue's own wording, when it isn't a plain number. */
	text: string | null;
}

export type LineupKind = 'concert' | 'festival' | 'club' | 'tribute' | 'not_music';

export interface Lineup {
	kind: LineupKind;
	headliners: string[];
	support: string[];
	/** Which model (or "fake" title rules) produced the line-up. */
	source: string;
}

export type ArtistRole = 'headliner' | 'support';

export interface GigArtistRef {
	/** Key into artists.json: "mb:<mbid>" or "name:<normalised name>". */
	key: string;
	/** The name as the listing spells it. */
	name: string;
	role: ArtistRole;
}

export interface Gig {
	/** "<venue>:<source_id>", unique across the file. */
	id: string;
	/** Where the show physically happens (e.g. Bimhuis for Muziekgebouw's Bimhuis room). */
	place: string;
	/** Slug of the venue that listed it (a key of GigsFile.venues). */
	venue: string;
	/** The venue's own ID, unique per venue and stable across runs. */
	source_id: string;
	title: string;
	subtitle: string | null;
	start: IsoDateTime;
	doors: IsoDateTime | null;
	end: IsoDateTime | null;
	room: string | null;
	city: string | null;
	performers: string[];
	support: string[];
	/** The venue's own genre labels, verbatim ("Alternative / Indie / Rock"). */
	genres: string[];
	categories: string[];
	status: GigStatus;
	availability: Availability;
	price: Price | null;
	ticket_url: string | null;
	url: string | null;
	image: string | null;
	description: string | null;
	extra: Record<string, unknown>;
	lineup: Lineup;
	artists: GigArtistRef[];
}

export interface GigsFile {
	/** When the pipeline ran. */
	generated: IsoDateTime;
	/** First day the venues were asked for. */
	since: IsoDate;
	venues: Record<string, Venue>;
	/** Sorted by nothing in particular; the catalogue sorts by start. */
	gigs: Gig[];
}

export interface MusicBrainzMatch {
	mbid: string;
	name: string;
	disambiguation: string | null;
	/** Other exact-name artists on MusicBrainz. */
	namesakes: number;
	confidence: 'high' | 'medium' | 'low';
}

export type ArtistLinkKind =
	'bandcamp' | 'wikidata' | 'wikipedia' | 'youtube' | 'homepage' | 'soundcloud' | 'streaming';

export interface MusicBrainzDetails {
	mbid: string;
	name: string | null;
	/** "Group", "Person", "Orchestra"… */
	type: string | null;
	/** ISO 3166 code, e.g. "GB". */
	country: string | null;
	area: string | null;
	begin_area?: string | null;
	/** "2019", "2019-04" or "2019-04-01". */
	begin: string | null;
	ended?: boolean | null;
	genres: string[];
	tags: string[];
	links: Partial<Record<ArtistLinkKind, string>>;
}

export interface LastFmInfo {
	name: string | null;
	mbid: string | null;
	url: string | null;
	listeners: number | null;
	playcount: number | null;
	tags: string[];
	similar: string[];
	bio: string | null;
}

export interface TopTrack {
	title: string | null;
	listeners: number | null;
	playcount: number | null;
}

export interface WikipediaSummary {
	title: string | null;
	lang: string;
	description: string | null;
	extract: string;
	url: string | null;
	thumbnail: string | null;
}

/** One song on the artist's YouTube Music page (pipeline/src/giggle_pipeline/ytmusic.py). */
export interface YoutubeSong {
	videoId: string;
	title: string;
	album: string | null;
}

/** The artist's YouTube Music match: `ArtistLookup.find` in ytmusic.py. */
export interface YoutubeArtist {
	browseId: string;
	name: string;
	/** As YouTube Music words it ("1.2M"); older records may hold a number. */
	monthlyListeners: string | number | null;
	image: string | null;
	songs: YoutubeSong[];
	description?: string | null;
}

export interface Artist {
	key: string;
	name: string;
	match: MusicBrainzMatch | null;
	musicbrainz: MusicBrainzDetails | null;
	lastfm: LastFmInfo | null;
	top_tracks: TopTrack[] | null;
	wikipedia: WikipediaSummary | null;
	/** Gig IDs, soonest first. */
	gigs: string[];
	/** YouTube Music match and songs; null when not found, absent in older output. */
	youtube?: YoutubeArtist | null;
	/** Announcer descriptors written by the pipeline ("a Glasgow four-piece…"). */
	blurbs?: string[];
	/** Pre-rendered intros, one per descriptor that has a clip. `clip` is relative to
	 * the data directory ("voice/<hash>.mp3"); `seconds` is the clip's exact length. */
	announce?: AnnounceClip[];
}

export interface AnnounceClip {
	text: string;
	clip: string;
	seconds: number;
	voice: string;
}

export interface ArtistsFile {
	artists: Record<string, Artist>;
}
