// The radio: radio-core's engine (queue, order, navigation, sessions, presenter, timing,
// ducking) driving a YouTube embed and the announcer (pre-rendered Kokoro intros, then
// Kokoro in the browser for live lines, with Web Speech as the fallback).
//
// UI state is in `$state` fields the page reads. The player, the ducking controller, the
// presenter, the speaker and timers live in private (#) fields: never in `$state`.

import {
	buildQueue,
	clampPosition,
	cleanSongTitle,
	DuckingController,
	dropTrack,
	mergeHistory,
	mulberry32,
	newSeed,
	nextArtistPosition,
	nextPosition,
	orderQueue,
	planSegment,
	Presenter,
	previousPosition,
	recordPlay,
	restoreSession,
	runSegment,
	snapshotSession,
	START,
	type Artist as CoreArtist,
	type Gig as CoreGig,
	type IntroClip,
	type Line,
	type LineKind,
	type OrderContext,
	type PlayerError,
	type PlayHistory,
	type QueueEntry,
	type QueuePosition,
	type RadioOrder,
	type Track,
	type Venue,
	type VoiceMode
} from '@giggle/radio-core';
import { keysIn, namesIn, POSITIVE, type Board, type Triage } from '$lib/board/board';
import { boardStore } from '$lib/board/board-store.svelte';
import { formatDay, localDate } from '$lib/data/dates';
import { localChanged, onSynced } from '$lib/sync/app';
import {
	bindMediaActions,
	setNowPlaying,
	setPlaybackState,
	setPositionState
} from './media-session';
import {
	loadHistory,
	loadSaid,
	loadSession,
	loadSettings,
	loadUnplayable,
	saveHistory,
	saveSaid,
	saveSession,
	saveSettings,
	saveUnplayable,
	type LiveVoice,
	type RadioSettings,
	type Unplayable
} from './persist';
import {
	ClipSpeaker,
	KokoroSpeaker,
	WebSpeechSpeaker,
	watchVoices,
	type Speaker,
	type VoiceInfo
} from './speaker';
import { MediaFocus } from './media-focus';
import { DEFAULT_ANNOUNCER, squareImage } from './tracks';
import { sharedKokoro, type KokoroState, type KokoroVoice } from '$lib/voice/kokoro';
import { isUnplayable, YouTubePlayer, type PlaybackState } from './youtube';

/** An artist counts as heard after this much listening. */
export const HEARD_AFTER_SECONDS = 30;
/** Session snapshots while playing, besides pagehide / visibilitychange. */
const SAVE_EVERY_MS = 5_000;
/** "Previous" restarts the track instead when this far in. */
const RESTART_AFTER_SECONDS = 5;
/** Consecutive tracks that fail before the radio stops trying. */
const MAX_ERRORS_IN_A_ROW = 6;
/** How long a passing notice (a skipped track, and so on) stays up. */
const NOTICE_MS = 10_000;

export interface StationInput {
	/** `stationKey(filters)`: which gigs; sessions are saved under it. */
	key: string;
	/** The station's gigs (already filtered, unavailable dates included). */
	gigs: readonly CoreGig[];
	/** Each artist's tracks, best first (tracks.ts `trackIndex`). */
	tracks: ReadonlyMap<string, readonly Track[]>;
	artists: Readonly<Record<string, CoreArtist>>;
	/** Pre-rendered intro clips by artist key (the pipeline's Kokoro voices). */
	clips?: Readonly<Record<string, readonly IntroClip[]>>;
	order: RadioOrder;
	/** The URL named the order, so a session saved in another order isn't resumed. */
	orderGiven: boolean;
	seed: number | null;
}

export interface Caption {
	text: string;
	kind: LineKind;
	artistKey: string;
}

export interface RadioOptions {
	venues: Readonly<Record<string, Venue>>;
	/** The listener changed the order or reshuffled: put it in the URL. */
	onOrderChange?: (order: RadioOrder, seed: number) => void;
	/** For artwork: the artist's picture. */
	image?: (entry: QueueEntry) => string | null;
	/** The artist's announcer voice, for live lines in Kokoro (tracks.ts `announcerOf`). */
	voiceFor?: (artistKey: string) => string;
	speaker?: Speaker;
	kokoro?: KokoroVoice;
}

/** What's to be said before a track, decided ahead so the live voice can render it. */
interface Planned {
	artistKey: string;
	trackIndex: number;
	videoId: string;
	mode: VoiceMode;
	/** `announcedArtistKey` when it was decided: the line only fits if that still holds. */
	announced: string | undefined;
	line: Line | null;
	/** When it was decided (Date.now()): "tonight" may not be right for ever. */
	at: number;
}

/** A plan older than this is decided again (the day may have turned). */
const PLAN_MAX_AGE_MS = 15 * 60_000;

interface BackAnnouncement {
	videoId: string;
	line: Line | null;
	abort: AbortController | null;
	done: boolean;
	/** Its mark on the scrub bar, once planned. */
	mark: number | null;
}

/** An announcement on the current track's timeline, for the scrub bar (seconds of track time). */
export interface VoiceMark {
	id: number;
	kind: LineKind;
	text: string;
	start: number;
	end: number;
	/** planned: a back-announcement still to come; speaking: on air now; done: said. */
	state: 'planned' | 'speaking' | 'done';
}

/** The announcer talking before a track starts (the music is silent), for the scrub bar. */
export interface Preroll {
	text: string;
	/** Estimated length. */
	seconds: number;
	/** When it started (Date.now()). */
	since: number;
}

export class Radio {
	// ---------- reactive state for the UI ----------
	queue = $state.raw<QueueEntry[]>([]);
	position = $state.raw<QueuePosition>({ ...START });
	/** The embed's state. */
	playback = $state<PlaybackState>('unstarted');
	/** The listener has pressed play at least once (so audio is allowed). */
	started = $state(false);
	/** A restored session waits here, paused at this many seconds, until "Resume". */
	resumeAt = $state<number | null>(null);
	time = $state(0);
	duration = $state(0);
	/** The announcer's latest line for this artist. */
	caption = $state.raw<Caption | null>(null);
	speaking = $state(false);
	/** Talking before the track starts (the music is silent, but the radio is "on"). */
	talking = $state(false);
	order = $state<RadioOrder>('mix');
	seed = $state(0);
	settings = $state<RadioSettings>(loadSettings());
	voices = $state.raw<VoiceInfo[]>([]);
	/** In-browser Kokoro: loading, ready (on what), failed. */
	kokoro = $state.raw<KokoroState | null>(null);
	/** Kokoro rendered far slower than real time here, so the browser voice took over. */
	liveSlow = $state(false);
	/** A message: a passing one (a skipped track, and so on), or why the radio stopped. */
	notice = $state<string | null>(null);
	/** Artists on this station without any track to play. */
	withoutTracks = $state(0);
	/** Artists on this station marked "not for me". */
	skipped = $state(0);
	ready = $state(false);

	entry = $derived<QueueEntry | undefined>(this.queue[this.position.artistIndex]);
	track = $derived<Track | undefined>(this.entry?.tracks[this.position.trackIndex]);
	/** Playing, or talking a track in: the play button shows "pause". */
	on = $derived(this.talking || this.playback === 'playing' || this.playback === 'buffering');

	/** The current track's announcements, for the scrub bar. */
	marks = $state.raw<VoiceMark[]>([]);
	/** Talking before the track starts, for the scrub bar; null otherwise. */
	preroll = $state.raw<Preroll | null>(null);

	// ---------- engine objects: never reactive ----------
	#player: YouTubePlayer | null = null;
	#ducking: DuckingController | null = null;
	readonly #speaker: Speaker;
	/** The browser's voice: the fallback for live lines, or the live voice if picked. */
	readonly #webSpeech: WebSpeechSpeaker;
	/** The live voice: says whole lines, or the gig part after a pre-rendered clip. */
	readonly #live: KokoroSpeaker;
	readonly #kokoro: KokoroVoice;
	/** Lines for where the listener may go next (the next track, the next artist), decided
	 * while this track plays so they can be rendered ahead. */
	#plans: Planned[] = [];
	/** Aborts on every move: renders prepared for the old position that the voice hasn't
	 * started on are dropped (what's still wanted is prepared again). */
	#prepared = new AbortController();
	readonly #presenter: Presenter;
	/** The board the presenter's "if you like …" names came from. */
	#knownFrom: Board | null = null;
	/** Keeps the laptop's media keys on giggle rather than the YouTube iframe (media-focus.ts). */
	readonly #focus = new MediaFocus();
	readonly #options: RadioOptions;
	#history: PlayHistory;
	/** Songs YouTube wouldn't play here lately: left out of the queue. */
	#unplayable: Unplayable;
	#noticeTimer: ReturnType<typeof setTimeout> | undefined;
	#station: StationInput | null = null;
	#segment: AbortController | null = null;
	/** What `#segment` says. If it names the song, a track failing under it isn't swapped. */
	#segmentLine: Line | null = null;
	#back: BackAnnouncement | null = null;
	/** Whose intro the listener last heard (radio-core's `announcedArtistKey`). */
	#announced: string | undefined;
	#announcedBefore: string | undefined;
	/** The video an intro was said over, until it plays; if it fails, the intro is redone. */
	#introVideo: string | null = null;
	/** The video shown cued (paused, never played): playing it goes through `#goTo`, and an
	 * error on it just moves the cue on. */
	#cued: string | null = null;
	#lastSpeechEnd: number | null = null;
	#speechToken = 0;
	#markId = 0;
	/** The video the marks belong to. */
	#marksFor: string | null = null;
	#heard = { key: '', seconds: 0, recorded: false };
	#errors = 0;
	#lastSave = 0;
	#cleanup: (() => void)[] = [];

	constructor(options: RadioOptions) {
		const now = new Date();
		this.#options = options;
		this.#history = loadHistory(now);
		this.#unplayable = loadUnplayable(now);
		// Plays heard on other devices: Mix plays those artists less often from the next reorder.
		this.#cleanup.push(
			onSynced('plays', (synced) => {
				this.#history = mergeHistory(this.#history, synced, new Date());
			})
		);
		this.#webSpeech = new WebSpeechSpeaker(this.settings.voiceName);
		this.#kokoro = options.kokoro ?? sharedKokoro();
		this.#live = new KokoroSpeaker(this.#kokoro, this.#webSpeech, {
			voiceFor: options.voiceFor ?? (() => DEFAULT_ANNOUNCER)
		});
		this.#live.enabled = this.settings.liveVoice === 'kokoro';
		this.#speaker = options.speaker ?? new ClipSpeaker(this.#live);
		this.#presenter = new Presenter({
			rng: mulberry32(newSeed()),
			venues: options.venues,
			said: loadSaid(now)
		});
	}

	// ---------- lifecycle ----------

	/** Puts the YouTube embed into `container` and starts the clock. Returns a cleanup. */
	attach(container: HTMLElement): () => void {
		const player = new YouTubePlayer(container, this.settings.volume);
		this.#player = player;
		this.#ducking = new DuckingController(player);
		this.#cleanup.push(
			player.onStateChange((state) => this.#onState(state)),
			player.onPlaying(() => this.#onPlaying()),
			player.onEnded(() => this.#onEnded()),
			player.onError((error) => this.#onError(error)),
			watchVoices((voices) => (this.voices = voices.map((v) => ({ name: v.name, lang: v.lang })))),
			bindMediaActions({
				play: () => this.play(),
				pause: () => this.pause(),
				nexttrack: () => this.next(),
				previoustrack: () => this.previous()
			}),
			this.#kokoro.subscribe((state) => (this.kokoro = state))
		);
		// The model takes a few seconds to load (and downloads once): start before play.
		if (this.#live.enabled) void this.#kokoro.load().catch(() => {});
		const ticker = setInterval(() => this.#tick(), 500);
		this.#cleanup.push(() => clearInterval(ticker));
		void player.ready.then(() => (this.ready = true));
		this.#cue();
		return () => this.destroy();
	}

	destroy(): void {
		this.save();
		this.#cancelSegment();
		this.#cancelBack();
		this.#dropPrepared();
		this.#ducking?.cancel();
		this.#speaker.stop();
		clearTimeout(this.#noticeTimer);
		for (const fn of this.#cleanup.splice(0)) fn();
		this.#player?.destroy();
		this.#player = null;
		this.#ducking = null;
		setNowPlaying(null);
		setPlaybackState('none');
	}

	// ---------- the station ----------

	/**
	 * Sets or updates the station; with `play` (from a user gesture), it plays too. Call
	 * outside reactive tracking (`untrack`).
	 */
	setStation(input: StationInput, { play = false } = {}): void {
		const previous = this.#station;
		if (previous && previous.key === input.key) {
			this.#station = input;
			// Same filters, other gigs: the listener's unavailable dates changed.
			if (!sameGigs(previous.gigs, input.gigs)) this.#rebuild();
			const seed = input.seed ?? this.seed;
			if (input.orderGiven && (input.order !== this.order || seed !== this.seed)) {
				this.#reorder(input.order, seed, false);
			}
			if (play && !this.on) this.play();
			return;
		}
		if (previous) this.save();
		this.#station = input;
		const entries = this.#build();
		const now = new Date();
		const saved = loadSession(input.key);
		const usable =
			saved &&
			(!input.orderGiven || saved.order === input.order) &&
			(input.seed === null || saved.seed === input.seed);

		const wasVideo = this.track?.videoId;
		if (saved && usable) {
			const restored = restoreSession(saved, entries, {
				now,
				history: this.#history,
				listenMore: keysIn(boardStore.items, ['listen'])
			});
			this.order = saved.order;
			this.seed = saved.seed;
			this.queue = restored.queue;
			this.position = { ...restored.position, seconds: 0 };
			// Not playing: it waits where it was left, for "play".
			this.resumeAt = this.on || !this.track ? null : restored.position.seconds;
			this.#follow(wasVideo, play);
			return;
		}

		this.order = input.order;
		this.seed = input.seed ?? newSeed();
		const ordered = orderQueue(entries, this.order, this.#orderContext());
		const current = this.started ? this.entry : undefined;
		const keep = current && ordered.find((e) => e.artistKey === current.artistKey);
		if (keep) {
			// Still on the new station: keep playing it, and go on to the new station after.
			this.queue = [keep, ...ordered.filter((e) => e !== keep)];
			this.position = clampPosition(this.queue, { ...this.position, artistIndex: 0 });
		} else {
			this.queue = ordered;
			this.position = { ...START };
			this.resumeAt = null;
		}
		this.#follow(wasVideo, play);
	}

	/**
	 * After the queue changed under the listener (another station, a rebuilt queue): if that
	 * changed the track, the new one plays (announced) when the radio is on, and is cued
	 * otherwise, so the video and the scrub bar never show a track the radio has moved off.
	 * With `play`, it plays either way (not cued first: YouTube drops a play sent mid-cue).
	 */
	#follow(wasVideo: string | undefined, play = false): void {
		const moved = this.track?.videoId !== wasVideo;
		if (this.on) return moved ? this.#goTo(this.position) : this.#describe();
		if (moved) {
			this.#cancelSegment();
			this.#cancelBack();
			this.#leaveTrack();
		}
		if (play) return this.play();
		if (moved) this.#cue();
		this.#describe();
	}

	/** Not playing: shows the current track in the embed, paused (at `resumeAt`, else its start). */
	#cue(): void {
		const player = this.#player;
		const track = this.track;
		if (!player || !track || player.videoId === track.videoId) return;
		this.#cancelBack();
		this.#leaveTrack();
		this.#cued = track.videoId;
		player.cue(track, this.resumeAt ?? 0);
	}

	/** Moving to the current track: what the UI showed of the last one (clock, announcements) goes. */
	#leaveTrack(): void {
		this.preroll = null;
		this.#marksFor = this.track?.videoId ?? null;
		this.marks = [];
		this.time = 0;
		this.duration = 0;
		if (this.caption && this.caption.artistKey !== this.entry?.artistKey) this.caption = null;
	}

	/** Builds the station's entries (soonest first) with the current settings and board. */
	#build(): QueueEntry[] {
		const station = this.#station;
		if (!station) return [];
		const unplayable = this.#unplayable;
		const built = buildQueue({
			gigs: station.gigs,
			tracks: (key) =>
				station.tracks.get(key)?.filter((t) => !Object.hasOwn(unplayable, t.videoId)),
			now: new Date(),
			tracksPerArtist: this.settings.tracksPerArtist,
			notForMe: keysIn(boardStore.items, ['nope']),
			artists: station.artists
		});
		this.withoutTracks = built.withoutTracks.length;
		this.skipped = built.notForMe.length;
		return built.entries;
	}

	#orderContext(seed = this.seed): OrderContext {
		return {
			seed,
			now: new Date(),
			history: this.#history,
			listenMore: keysIn(boardStore.items, ['listen'])
		};
	}

	/** Rebuilds the entries (settings or board changed), keeping the queue's arrangement. */
	#rebuild(): void {
		const station = this.#station;
		if (!station) return;
		const wasVideo = this.track?.videoId;
		const snapshot = snapshotSession({
			filtersKey: station.key,
			seed: this.seed,
			order: this.order,
			queue: this.queue,
			position: this.position,
			now: new Date()
		});
		const restored = restoreSession(snapshot, this.#build(), {
			now: new Date(),
			history: this.#history,
			listenMore: keysIn(boardStore.items, ['listen'])
		});
		this.queue = restored.queue;
		this.position = { ...restored.position, seconds: 0 };
		if (this.track?.videoId !== wasVideo) this.resumeAt = null;
		this.#follow(wasVideo);
	}

	/** Reorders everything after the current artist, which keeps playing. */
	#reorder(order: RadioOrder, seed: number, notify: boolean): void {
		this.order = order;
		this.seed = seed;
		const ordered = orderQueue(this.queue, order, this.#orderContext(seed));
		const current = this.entry;
		this.queue = current ? [current, ...ordered.filter((e) => e !== current)] : ordered;
		this.position = { ...this.position, artistIndex: 0 };
		if (notify) this.#options.onOrderChange?.(order, seed);
		this.save();
	}

	/** Picks an order; picking Mix or Shuffle again reshuffles. */
	setOrder(order: RadioOrder): void {
		const reshuffle = order === this.order && order !== 'date';
		this.#reorder(order, reshuffle ? newSeed() : this.seed, true);
	}

	setTracksPerArtist(n: number): void {
		if (n === this.settings.tracksPerArtist) return;
		this.settings.tracksPerArtist = n;
		saveSettings(this.settings);
		this.#rebuild();
	}

	setVoiceMode(mode: VoiceMode): void {
		this.settings.voiceMode = mode;
		saveSettings(this.settings);
		if (mode === 'off') {
			this.#cancelBack();
			if (this.speaking) {
				this.#ducking?.cancel();
				this.#speaker.stop();
			}
		}
	}

	setVoiceName(name: string): void {
		this.settings.voiceName = name;
		saveSettings(this.settings);
		this.#webSpeech.voiceName = name;
		this.#sample();
	}

	setLiveVoice(voice: LiveVoice): void {
		this.settings.liveVoice = voice;
		saveSettings(this.settings);
		this.#live.enabled = voice === 'kokoro';
		this.#plans = [];
		this.#dropPrepared();
		if (this.on) this.#planAhead();
		if (voice === 'kokoro')
			void this.#kokoro.load().then(
				() => this.#sample(),
				() => {}
			);
		else this.#sample();
	}

	/** "This is how I sound.", in the voice live lines use now. */
	#sample(): void {
		this.#unlock();
		const text = 'This is how I sound.';
		const line = {
			kind: 'micro' as const,
			text,
			seconds: 2,
			artistKey: this.entry?.artistKey ?? ''
		};
		if (this.#ducking) void this.#ducking.duck((signal) => this.#say(line, signal));
		else void this.#say(line, new AbortController().signal);
	}

	/** Whether giggle holds the media keys now (for tests and debugging). */
	get holdsMediaKeys(): boolean {
		return this.#focus.active;
	}

	/** From a user gesture: lets speech, clips and the media-key loop play later. */
	#unlock(): void {
		this.#speaker.unlock?.();
		this.#focus.unlock();
	}

	// ---------- transport ----------

	/**
	 * Play (a user gesture: audio and speech are allowed after it). Carries on where it was
	 * paused, or where a restored session left off (without an intro); a track that was only
	 * cued, or isn't loaded, plays from the top with its announcement.
	 */
	play(): void {
		this.#unlock();
		const player = this.#player;
		const track = this.track;
		if (!player || !track) return;
		this.#notify(null);
		const loaded = player.videoId === track.videoId;
		const at = this.resumeAt;
		if (at !== null) {
			// Loaded afresh there: YouTube drops a play sent while a cue is still loading.
			this.started = true;
			this.resumeAt = null;
			this.#cued = null;
			this.#announced = this.entry?.artistKey;
			this.#describe();
			player.load(track, at);
			return;
		}
		if (
			!loaded ||
			this.#cued === track.videoId ||
			player.state === 'ended' ||
			player.state === 'unstarted'
		) {
			return this.#goTo(this.position);
		}
		player.play();
	}

	togglePlay(): void {
		if (this.on) this.pause();
		else this.play();
	}

	pause(): void {
		this.#cancelSegment();
		this.#cancelBack();
		this.#ducking?.cancel();
		this.#speaker.stop();
		this.talking = false;
		this.#player?.pause();
		this.#focus.release();
		this.save();
	}

	next(): void {
		this.#unlock();
		this.#goTo(nextPosition(this.queue, this.position));
	}

	previous(): void {
		this.#unlock();
		if (
			this.started &&
			this.time > RESTART_AFTER_SECONDS &&
			this.#player?.videoId === this.track?.videoId
		) {
			this.#player?.seek(0);
			return;
		}
		this.#goTo(previousPosition(this.queue, this.position));
	}

	nextArtist(): void {
		this.#unlock();
		this.#goTo(nextArtistPosition(this.queue, this.position));
	}

	jump(artistIndex: number): void {
		this.#unlock();
		this.#goTo({ artistIndex, trackIndex: 0, seconds: 0 });
	}

	/** Seeks to `fraction` (0–1) of the current track. */
	seekTo(fraction: number): void {
		const player = this.#player;
		if (!player || !this.duration || player.videoId !== this.track?.videoId) return;
		this.#cancelBack();
		player.seek(fraction * this.duration);
		this.time = fraction * this.duration;
	}

	// ---------- triage ----------

	triage(state: Triage): void {
		const entry = this.entry;
		if (!entry) return;
		boardStore.toggle(entry.artistKey, state, {
			name: entry.name,
			gig: entry.gig.id,
			when: entry.gig.start
		});
		// "Not for me" skips them and takes them off the station.
		if (boardStore.stateOf(entry.artistKey) === 'nope') {
			this.#notify(`${entry.name}: not for you. Skipped, and they won't come round again.`);
			this.#rebuild();
		}
	}

	// ---------- playing a track ----------

	/** Moves to `pos` and plays it, with whatever the presenter has to say first. */
	#goTo(pos: QueuePosition): void {
		const player = this.#player;
		const ducking = this.#ducking;
		if (!player || !ducking || !this.queue.length) return;
		const target = clampPosition(this.queue, pos);
		const entry = this.queue[target.artistIndex];
		const track = entry?.tracks[target.trackIndex];
		if (!entry || !track) return;

		this.#cancelSegment();
		this.#cancelBack();
		this.started = true;
		this.resumeAt = null;
		this.#cued = null;
		this.position = { ...target, seconds: 0 };
		this.#leaveTrack();

		const voice = this.settings.voiceMode;
		// What was prepared for the old position and hasn't started rendering: dropped.
		// (The line said now is asked for again; plans still wanted are prepared again.)
		this.#dropPrepared();
		const planned = this.#planFor(entry, target.trackIndex, track.videoId, voice);
		this.#plans = this.#plans.filter((p) => p !== planned);
		const line = planned
			? planned.line
			: this.#presenterNow().forTrack({
					entry,
					trackIndex: target.trackIndex,
					mode: voice,
					now: new Date(),
					announcedArtistKey: this.#announced,
					clip: this.#clipFor(entry.artistKey),
					// Not rendered ahead: open with a short sentence, so the voice starts sooner.
					quick: this.#live.active
				});
		if (line?.kind === 'intro') {
			this.#announcedBefore = this.#announced;
			this.#announced = entry.artistKey;
			this.#introVideo = track.videoId;
			saveSaid(this.#presenter.said);
		}
		const since =
			this.#lastSpeechEnd === null ? undefined : (Date.now() - this.#lastSpeechEnd) / 1000;
		const plan = planSegment({ line, voice, sinceLastSpeechSeconds: since });
		this.#describe();

		if (plan.mode === 'beforeTrack') player.pause();
		const abort = new AbortController();
		this.#segment = abort;
		this.#segmentLine = line;
		this.talking = plan.mode === 'beforeTrack';
		void runSegment(plan, {
			player,
			ducking,
			speak: (signal) => {
				let said: Promise<void> = Promise.resolve();
				if (line && plan.mode === 'beforeTrack') {
					const preroll = { text: line.text, seconds: line.seconds, since: Date.now() };
					this.preroll = preroll;
					said = this.#say(line, signal).finally(() => {
						if (this.preroll === preroll) this.preroll = null;
					});
				} else if (line) {
					said = this.#sayOver(line, signal, track.videoId);
				}
				// While this line is said, get the next ones ready: the listener may skip on
				// before the track even starts. (After asking for this line, so it goes first.)
				this.#planAhead();
				return said;
			},
			startTrack: () => {
				if (abort.signal.aborted) return;
				this.talking = false;
				this.preroll = null;
				player.load(track);
			},
			signal: abort.signal
		})
			.catch((error) => console.error('radio: announcement failed', error))
			.finally(() => {
				if (this.#segment === abort) {
					this.#segment = null;
					this.talking = false;
				}
			});
	}

	/**
	 * Decides what's said before the next artist and the next track while this one plays,
	 * so the live voice can render it ahead (Kokoro in Firefox takes about 1.3 s plus half
	 * the line's length to render each sentence). The next artist goes first: skipping
	 * there is the likeliest thing to happen soon. `#goTo` uses a plan if the radio does
	 * move there with nothing else changed; a plan not used yet is kept while it still
	 * fits (so the next artist's intro is decided once, however many tracks come first).
	 */
	#planAhead(): void {
		const mode = this.settings.voiceMode;
		if (!this.#live.enabled || mode === 'off' || !this.queue.length) {
			this.#plans = [];
			return;
		}
		const targets = [
			nextArtistPosition(this.queue, this.position),
			nextPosition(this.queue, this.position)
		];
		const plans: Planned[] = [];
		for (const pos of targets) {
			const entry = this.queue[pos.artistIndex];
			const track = entry?.tracks[pos.trackIndex];
			if (!entry || !track || track.videoId === this.track?.videoId) continue;
			if (plans.some((p) => p.videoId === track.videoId)) continue;
			const plan = this.#planFor(entry, pos.trackIndex, track.videoId, mode) ?? {
				artistKey: entry.artistKey,
				trackIndex: pos.trackIndex,
				videoId: track.videoId,
				mode,
				announced: this.#announced,
				line: this.#presenterNow().forTrack({
					entry,
					trackIndex: pos.trackIndex,
					mode,
					now: new Date(),
					announcedArtistKey: this.#announced,
					clip: this.#clipFor(entry.artistKey)
				}),
				at: Date.now()
			};
			plans.push(plan);
		}
		this.#plans = plans;
		const signal = this.#prepared.signal;
		for (const plan of plans) if (plan.line) this.#speaker.prepare?.(plan.line, { signal });
	}

	/** The presenter, knowing the listener's board as it is now (for "if you like …"). */
	#presenterNow(): Presenter {
		const board = boardStore.items;
		if (board !== this.#knownFrom) {
			this.#knownFrom = board;
			this.#presenter.setKnownArtists(namesIn(board, POSITIVE));
		}
		return this.#presenter;
	}

	/** A plan for this track that still fits, if there is one. */
	#planFor(entry: QueueEntry, trackIndex: number, videoId: string, mode: VoiceMode) {
		const now = Date.now();
		return this.#plans.find(
			(p) =>
				p.artistKey === entry.artistKey &&
				p.trackIndex === trackIndex &&
				p.videoId === videoId &&
				p.mode === mode &&
				p.announced === this.#announced &&
				now - p.at < PLAN_MAX_AGE_MS
		);
	}

	#dropPrepared(): void {
		this.#prepared.abort();
		this.#prepared = new AbortController();
	}

	/** One of the artist's pre-rendered intros, at random, so repeat plays vary. */
	#clipFor(artistKey: string): IntroClip | undefined {
		const clips = this.#station?.clips?.[artistKey];
		return clips?.length ? clips[Math.floor(Math.random() * clips.length)] : undefined;
	}

	async #say(
		line: Pick<Line, 'text' | 'kind' | 'artistKey' | 'seconds' | 'clip'>,
		signal: AbortSignal
	): Promise<void> {
		const token = ++this.#speechToken;
		this.caption = { text: line.text, kind: line.kind, artistKey: line.artistKey };
		this.speaking = true;
		try {
			await this.#speaker.speak(line, signal);
		} finally {
			if (token === this.#speechToken) this.speaking = false;
			this.#lastSpeechEnd = Date.now();
			this.liveSlow = this.#live.slow;
		}
	}

	/** Seconds into `videoId`, if it's the one loaded; else 0 (it's about to start). */
	#trackTime(videoId: string): number {
		const player = this.#player;
		return player && player.videoId === videoId ? player.currentTime() : 0;
	}

	#addMark(videoId: string, mark: Omit<VoiceMark, 'id'>): number {
		if (this.#marksFor !== videoId) {
			this.#marksFor = videoId;
			this.marks = [];
		}
		const id = ++this.#markId;
		this.marks = [...this.marks, { ...mark, id }];
		return id;
	}

	#updateMark(id: number, patch: Partial<VoiceMark>): void {
		this.marks = this.marks.map((m) => (m.id === id ? { ...m, ...patch } : m));
	}

	#dropMark(id: number): void {
		this.marks = this.marks.filter((m) => m.id !== id);
	}

	/** Says `line` over the track's music, marking where on the track it fell. */
	#sayOver(
		line: Pick<Line, 'text' | 'kind' | 'artistKey' | 'seconds' | 'clip'>,
		signal: AbortSignal,
		videoId: string,
		mark?: number
	): Promise<void> {
		const start = this.#trackTime(videoId);
		const id =
			mark ??
			this.#addMark(videoId, {
				kind: line.kind,
				text: line.text,
				start,
				end: start + line.seconds,
				state: 'speaking'
			});
		if (mark !== undefined)
			this.#updateMark(id, { start, end: start + line.seconds, state: 'speaking' });
		return this.#say(line, signal).finally(() => {
			const end = this.#trackTime(videoId);
			if (signal.aborted && end <= start) this.#dropMark(id);
			else this.#updateMark(id, { end: Math.max(end, start + 0.5), state: 'done' });
		});
	}

	#cancelSegment(): void {
		this.#segment?.abort();
		this.#segment = null;
	}

	#cancelBack(): void {
		const back = this.#back;
		if (back?.abort) {
			back.abort.abort();
			back.abort = null;
		}
	}

	/** Maybe "That was …" over the end of the current track (Short mode only). */
	#scheduleBack(): void {
		const player = this.#player;
		const ducking = this.#ducking;
		const entry = this.entry;
		const track = this.track;
		if (!player || !ducking || !entry || !track || this.settings.voiceMode !== 'short') return;
		if (player.videoId !== track.videoId || player.state !== 'playing') return;
		if (this.#back?.videoId !== track.videoId) {
			this.#back = {
				videoId: track.videoId,
				line: this.#presenter.backAnnounce(entry, this.position.trackIndex),
				abort: null,
				done: false,
				mark: null
			};
			if (this.#back.line)
				this.#speaker.prepare?.(this.#back.line, { signal: this.#prepared.signal });
		}
		const back = this.#back;
		if (back.done || !back.line || back.abort) return;
		const duration = player.duration();
		if (!(duration > 0)) return; // the ticker tries again
		const plan = planSegment({
			line: back.line,
			voice: 'short',
			finishing: { durationSeconds: duration }
		});
		const at = player.currentTime();
		if (plan.mode !== 'backAnnounce' || at > plan.startAt + 0.5) {
			back.done = true;
			if (back.mark !== null) this.#dropMark(back.mark);
			return;
		}
		// Show where it will come in, before it does.
		back.mark ??= this.#addMark(track.videoId, {
			kind: back.line.kind,
			text: back.line.text,
			start: plan.startAt,
			end: plan.startAt + plan.speechSeconds,
			state: 'planned'
		});
		const mark = back.mark;
		const abort = new AbortController();
		back.abort = abort;
		const line = back.line;
		void runSegment(plan, {
			player,
			ducking,
			speak: (signal) => this.#sayOver(line, signal, track.videoId, mark),
			positionSeconds: at,
			signal: abort.signal
		})
			.then((result) => {
				if (result.spoke) back.done = true;
			})
			.catch((error) => console.error('radio: back-announcement failed', error))
			.finally(() => {
				if (back.abort === abort) back.abort = null;
			});
	}

	// ---------- player events ----------

	#onState(state: PlaybackState): void {
		this.playback = state;
		if (state === 'cued') this.#errors = 0;
		if (state === 'playing') setPlaybackState('playing');
		else if (state === 'paused' || state === 'cued') setPlaybackState('paused');
		// Paused (here, or with YouTube's own controls): let the media-key loop rest too.
		if (state === 'paused') this.#focus.release();
		if (state !== 'playing') this.#cancelBack();
	}

	#onPlaying(): void {
		const player = this.#player;
		if (!player) return;
		this.#errors = 0;
		if (player.videoId === this.#introVideo) this.#introVideo = null;
		// Each YouTube track makes its iframe the media keys' target: take them back.
		this.#focus.claim();
		this.#planAhead(); // first: the next artist's intro is wanted before the outro line
		this.#scheduleBack();
	}

	#onEnded(): void {
		if (this.#player?.videoId !== this.track?.videoId) return;
		this.#goTo(nextPosition(this.queue, this.position));
	}

	#onError(error: PlayerError): void {
		const player = this.#player;
		const entry = this.entry;
		const track = this.track;
		if (!player || !entry || !track || player.videoId !== track.videoId) return;
		this.#errors++;
		const song = cleanSongTitle(track.title, entry.name) || track.title;
		// Gone, or not allowed outside YouTube: it leaves the queue (and stays out for a while).
		const gone = isUnplayable(error);
		if (gone) this.#markUnplayable(track.videoId);
		const { queue, next } = gone
			? dropTrack(this.queue, this.position)
			: { queue: this.queue, next: nextPosition(this.queue, this.position) };
		if (queue.length < this.queue.length) this.withoutTracks++;
		if (!queue.length) {
			this.queue = queue;
			this.position = { ...START };
			this.pause();
			this.#notify("None of this station's songs will play here.", false);
			return;
		}
		const cueing = this.#cued === track.videoId;
		if (this.#errors >= MAX_ERRORS_IN_A_ROW && (!cueing || !gone)) {
			// Stop trying (a gone track is off the queue, so a shrinking queue can't loop).
			this.#errors = 0;
			if (!cueing) this.pause();
			if (gone) this.#showInstead(queue, next);
			if (!cueing)
				this.#notify(
					"Several tracks in a row wouldn't play. Check your connection, then press play.",
					false
				);
			return;
		}
		if (cueing) {
			// Found while cueing, not playing: quietly show the next track instead.
			this.#showInstead(queue, next);
			return;
		}
		this.#notify(
			gone
				? `Skipped “${song}”: ${error.message}.`
				: `Couldn't play “${song}” (${error.message ?? error.code}), skipping it.`
		);
		this.queue = queue;
		const nextTrack = queue[next.artistIndex]?.tracks[next.trackIndex];
		const named = this.#segmentLine?.facts.includes('track') ?? false;
		// Mid-intro and the next track is the same artist's: swap it in under the voice, unless
		// the voice names the song (then the next track gets its own line).
		if (
			this.#segment &&
			this.speaking &&
			!named &&
			queue[next.artistIndex]?.artistKey === entry.artistKey &&
			nextTrack
		) {
			this.position = { ...next, seconds: 0 };
			this.#introVideo = nextTrack.videoId;
			this.#describe();
			player.load(nextTrack);
			return;
		}
		// The intro named a song nobody heard: introduce them again with the next one.
		if (this.#introVideo === track.videoId && named) this.#announced = this.#announcedBefore;
		this.#introVideo = null;
		this.#goTo(next);
	}

	/** Not playing: moves to `next` in `queue` and shows it, cued. */
	#showInstead(queue: QueueEntry[], next: QueuePosition): void {
		this.queue = queue;
		this.position = clampPosition(queue, next);
		this.resumeAt = null;
		this.#cue();
		this.#describe();
	}

	/** Remembers a song YouTube won't play here (with other tabs' finds), so it's left out. */
	#markUnplayable(videoId: string): void {
		const now = new Date();
		this.#unplayable = { ...loadUnplayable(now), [videoId]: now.toISOString() };
		saveUnplayable(this.#unplayable);
	}

	/**
	 * Shows `text` (null: nothing). Passing notices go by themselves; `passing: false` stays
	 * until the listener presses play.
	 */
	#notify(text: string | null, passing = true): void {
		clearTimeout(this.#noticeTimer);
		this.notice = text;
		if (text && passing) this.#noticeTimer = setTimeout(() => (this.notice = null), NOTICE_MS);
	}

	#tick(): void {
		const player = this.#player;
		if (!player) return;
		const state = player.state;
		// The clock is the current track's only: not a paused one the radio has moved off (while
		// its next track is announced, say).
		if (
			this.resumeAt === null &&
			player.videoId === this.track?.videoId &&
			(state === 'playing' || state === 'paused' || state === 'buffering')
		) {
			this.time = player.currentTime();
			this.duration = player.duration();
		}
		if (state !== 'playing' || player.videoId !== this.track?.videoId) return;

		// Heard: after 30 s of an artist in one visit.
		const key = this.entry?.artistKey ?? '';
		if (this.#heard.key !== key) this.#heard = { key, seconds: 0, recorded: false };
		this.#heard.seconds += 0.5;
		if (!this.#heard.recorded && this.#heard.seconds >= HEARD_AFTER_SECONDS && key) {
			this.#heard.recorded = true;
			// From storage, not memory: sync or another tab may have added plays since.
			const now = new Date();
			this.#history = recordPlay(mergeHistory(this.#history, loadHistory(now), now), key, now);
			saveHistory(this.#history);
			localChanged(); // synced in the background; the radio never waits for it
		}
		this.#scheduleBack(); // no-op once decided; waits for the duration otherwise
		setPositionState(this.duration, this.time);
		if (Date.now() - this.#lastSave > SAVE_EVERY_MS) this.save();
	}

	// ---------- persistence and the OS ----------

	/** Saves the session for this station (also call on pagehide / visibilitychange). */
	save(): void {
		const station = this.#station;
		if (!station || !this.queue.length || (!this.started && this.resumeAt === null)) return;
		const player = this.#player;
		const seconds =
			this.resumeAt ??
			(player && player.videoId === this.track?.videoId ? player.currentTime() : 0);
		saveSession(
			snapshotSession({
				filtersKey: station.key,
				seed: this.seed,
				order: this.order,
				queue: this.queue,
				position: { ...this.position, seconds },
				now: new Date()
			})
		);
		saveSaid(this.#presenter.said);
		this.#lastSave = Date.now();
	}

	/** Media Session metadata for the current track. */
	#describe(): void {
		const entry = this.entry;
		const track = this.track;
		if (!entry || !track) return setNowPlaying(null);
		const venue = this.#options.venues[entry.gig.venue]?.name ?? entry.gig.venue;
		const image = this.#options.image?.(entry) ?? null;
		setNowPlaying({
			title: cleanSongTitle(track.title, entry.name) || track.title,
			artist: entry.name,
			album: `${venue} · ${formatDay(localDate(entry.gig.start))}`,
			artwork: squareImage(image)
		});
	}
}

function sameGigs(a: readonly CoreGig[], b: readonly CoreGig[]): boolean {
	return a.length === b.length && a.every((gig, i) => gig.id === b[i]?.id);
}
