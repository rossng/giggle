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
	type TrackLookup,
	type Venue,
	type VoiceMode
} from '@giggle/radio-core';
import {
	keysIn,
	loadBoard,
	namesIn,
	POSITIVE,
	saveBoard,
	toggleTriage,
	type Board,
	type Triage
} from '$lib/board/board';
import { formatDay, localDate } from '$lib/data/dates';
import { boardChanged, localChanged, onBoardSynced, onSynced } from '$lib/sync/app';
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
	saveHistory,
	saveSaid,
	saveSession,
	saveSettings,
	type LiveVoice,
	type RadioSettings
} from './persist';
import {
	ClipSpeaker,
	KokoroSpeaker,
	WebSpeechSpeaker,
	watchVoices,
	type Speaker,
	type VoiceInfo
} from './speaker';
import { squareImage } from './tracks';
import { sharedKokoro, type KokoroState, type KokoroVoice } from '$lib/voice/kokoro';
import { YouTubePlayer, type PlaybackState } from './youtube';

/** An artist counts as heard after this much listening. */
export const HEARD_AFTER_SECONDS = 30;
/** Session snapshots while playing, besides pagehide / visibilitychange. */
const SAVE_EVERY_MS = 5_000;
/** "Previous" restarts the track instead when this far in. */
const RESTART_AFTER_SECONDS = 5;
/** Consecutive tracks that fail before the radio stops trying. */
const MAX_ERRORS_IN_A_ROW = 6;

export interface StationInput {
	/** `stationKey(filters)`: which gigs; sessions are saved under it. */
	key: string;
	/** The station's gigs (already filtered, unavailable dates included). */
	gigs: readonly CoreGig[];
	tracks: TrackLookup;
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
	speaker?: Speaker;
	kokoro?: KokoroVoice;
}

interface Upcoming {
	artistIndex: number;
	trackIndex: number;
	videoId: string;
	mode: VoiceMode;
	/** `announcedArtistKey` when it was decided: the line only fits if that still holds. */
	announced: string | undefined;
	line: Line | null;
}

interface BackAnnouncement {
	videoId: string;
	line: Line | null;
	abort: AbortController | null;
	done: boolean;
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
	board = $state.raw<Board>({});
	settings = $state<RadioSettings>(loadSettings());
	voices = $state.raw<VoiceInfo[]>([]);
	/** In-browser Kokoro: loading, ready (on what), failed. */
	kokoro = $state.raw<KokoroState | null>(null);
	/** Kokoro rendered far slower than real time here, so the browser voice took over. */
	liveSlow = $state(false);
	/** A passing message: a track that wouldn't play, and so on. */
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

	// ---------- engine objects: never reactive ----------
	#player: YouTubePlayer | null = null;
	#ducking: DuckingController | null = null;
	readonly #speaker: Speaker;
	/** The browser's voice: the fallback for live lines, or the live voice if picked. */
	readonly #webSpeech: WebSpeechSpeaker;
	/** The live voice: says whole lines, or the gig part after a pre-rendered clip. */
	readonly #live: KokoroSpeaker;
	readonly #kokoro: KokoroVoice;
	/** The next track's line, decided while this one plays so it can be rendered ahead. */
	#upcoming: Upcoming | null = null;
	readonly #presenter: Presenter;
	readonly #options: RadioOptions;
	#history: PlayHistory;
	#station: StationInput | null = null;
	#segment: AbortController | null = null;
	#back: BackAnnouncement | null = null;
	/** Whose intro the listener last heard (radio-core's `announcedArtistKey`). */
	#announced: string | undefined;
	#announcedBefore: string | undefined;
	/** The video an intro was said over, until it plays; if it fails, the intro is redone. */
	#introVideo: string | null = null;
	#lastSpeechEnd: number | null = null;
	#speechToken = 0;
	#heard = { key: '', seconds: 0, recorded: false };
	#errors = 0;
	#lastSave = 0;
	#cleanup: (() => void)[] = [];

	constructor(options: RadioOptions) {
		const now = new Date();
		this.#options = options;
		this.#history = loadHistory(now);
		this.board = loadBoard();
		this.#cleanup.push(onBoardSynced((synced) => (this.board = synced)));
		// Plays heard on other devices: Mix plays those artists less often from the next reorder.
		this.#cleanup.push(
			onSynced('plays', (synced) => {
				this.#history = mergeHistory(this.#history, synced, new Date());
			})
		);
		this.#webSpeech = new WebSpeechSpeaker(this.settings.voiceName);
		this.#kokoro = options.kokoro ?? sharedKokoro();
		this.#live = new KokoroSpeaker(this.#kokoro, this.#webSpeech);
		this.#live.enabled = this.settings.liveVoice === 'kokoro';
		this.#speaker = options.speaker ?? new ClipSpeaker(this.#live);
		this.#presenter = new Presenter({
			rng: mulberry32(newSeed()),
			venues: options.venues,
			said: loadSaid(now),
			knownArtists: namesIn(this.board, POSITIVE)
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
				play: () => (this.started ? this.resume() : this.start()),
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
		this.#cueIfIdle();
		return () => this.destroy();
	}

	destroy(): void {
		this.save();
		this.#cancelSegment();
		this.#cancelBack();
		this.#ducking?.cancel();
		this.#speaker.stop();
		for (const fn of this.#cleanup.splice(0)) fn();
		this.#player?.destroy();
		this.#player = null;
		this.#ducking = null;
		setNowPlaying(null);
		setPlaybackState('none');
	}

	// ---------- the station ----------

	/** Sets or updates the station. Call outside reactive tracking (`untrack`). */
	setStation(input: StationInput): void {
		const previous = this.#station;
		if (previous && previous.key === input.key) {
			this.#station = input;
			// Same filters, other gigs: the listener's unavailable dates changed.
			if (!sameGigs(previous.gigs, input.gigs)) this.#rebuild();
			const seed = input.seed ?? this.seed;
			if (input.orderGiven && (input.order !== this.order || seed !== this.seed)) {
				this.#reorder(input.order, seed, false);
			}
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

		if (saved && usable) {
			const restored = restoreSession(saved, entries, {
				now,
				history: this.#history,
				listenMore: keysIn(this.board, ['listen'])
			});
			this.order = saved.order;
			this.seed = saved.seed;
			this.queue = restored.queue;
			this.position = { ...restored.position, seconds: 0 };
			if (this.started) {
				if (this.on) this.#goTo(this.position);
			} else if (this.track) {
				this.resumeAt = restored.position.seconds;
				this.#announced = this.entry?.artistKey;
				this.#cueIfIdle();
			}
			this.#describe();
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
			if (this.started && this.on) this.#goTo(this.position);
		}
		this.#cueIfIdle();
		this.#describe();
	}

	/** Before the first play, shows the current track (paused) in the embed. */
	#cueIfIdle(): void {
		const player = this.#player;
		const track = this.track;
		if (this.started || !player || !track || player.videoId === track.videoId) return;
		player.cue(track, this.resumeAt ?? 0);
	}

	/** Builds the station's entries (soonest first) with the current settings and board. */
	#build(): QueueEntry[] {
		const station = this.#station;
		if (!station) return [];
		const built = buildQueue({
			gigs: station.gigs,
			tracks: station.tracks,
			now: new Date(),
			tracksPerArtist: this.settings.tracksPerArtist,
			notForMe: keysIn(this.board, ['nope']),
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
			listenMore: keysIn(this.board, ['listen'])
		};
	}

	/** Rebuilds the entries (settings or board changed), keeping the queue's arrangement. */
	#rebuild(): void {
		const station = this.#station;
		if (!station) return;
		const wasOn = this.on;
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
			listenMore: keysIn(this.board, ['listen'])
		});
		this.queue = restored.queue;
		this.position = { ...restored.position, seconds: 0 };
		if (this.track?.videoId === wasVideo) return;
		this.resumeAt = null;
		if (wasOn) this.#goTo(this.position);
		else {
			this.#cancelSegment();
			this.#player?.pause();
			this.#cueIfIdle();
			this.#describe();
		}
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
		this.#upcoming = null;
		if (voice === 'kokoro')
			void this.#kokoro.load().then(
				() => this.#sample(),
				() => {}
			);
		else this.#sample();
	}

	/** "This is how I sound.", in the voice live lines use now. */
	#sample(): void {
		this.#speaker.unlock?.();
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

	// ---------- transport ----------

	/** The first press of play (a user gesture: audio and speech are allowed after it). */
	start(): void {
		this.#speaker.unlock?.();
		const player = this.#player;
		if (!player || !this.track) return;
		this.notice = null;
		if (this.resumeAt !== null && player.videoId === this.track.videoId) {
			this.started = true;
			this.resumeAt = null;
			this.#announced = this.entry?.artistKey;
			player.play();
			return;
		}
		this.resumeAt = null;
		this.#goTo(this.position);
	}

	togglePlay(): void {
		if (!this.started) this.start();
		else if (this.on) this.pause();
		else this.resume();
	}

	pause(): void {
		this.#cancelSegment();
		this.#cancelBack();
		this.#ducking?.cancel();
		this.#speaker.stop();
		this.talking = false;
		this.#player?.pause();
		this.save();
	}

	resume(): void {
		const player = this.#player;
		if (!player || !this.track) return;
		if (!this.started) return this.start();
		this.#speaker.unlock?.();
		const loaded = player.videoId === this.track.videoId;
		if (loaded && player.state !== 'ended' && player.state !== 'unstarted') player.play();
		else this.#goTo(this.position);
	}

	next(): void {
		this.#speaker.unlock?.();
		this.#goTo(nextPosition(this.queue, this.position));
	}

	previous(): void {
		this.#speaker.unlock?.();
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
		this.#speaker.unlock?.();
		this.#goTo(nextArtistPosition(this.queue, this.position));
	}

	jump(artistIndex: number): void {
		this.#speaker.unlock?.();
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
		const board = toggleTriage(
			this.board,
			entry.artistKey,
			state,
			{ name: entry.name, gig: entry.gig.id, when: entry.gig.start },
			new Date()
		);
		this.board = board;
		saveBoard(board);
		boardChanged();
		this.#presenter.setKnownArtists(namesIn(board, POSITIVE));
		// "Not for me" skips them and takes them off the station.
		if (board[entry.artistKey]?.state === 'nope') {
			this.notice = `${entry.name}: not for you. Skipped, and they won't come round again.`;
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
		this.position = { ...target, seconds: 0 };
		this.time = 0;
		this.duration = 0;

		const voice = this.settings.voiceMode;
		const ahead = this.#upcoming;
		this.#upcoming = null;
		const planned =
			ahead &&
			ahead.artistIndex === target.artistIndex &&
			ahead.trackIndex === target.trackIndex &&
			ahead.videoId === track.videoId &&
			ahead.mode === voice &&
			ahead.announced === this.#announced;
		const line = planned
			? ahead.line
			: this.#presenter.forTrack({
					entry,
					trackIndex: target.trackIndex,
					mode: voice,
					now: new Date(),
					announcedArtistKey: this.#announced,
					clip: this.#clipFor(entry.artistKey)
				});
		if (line?.kind === 'intro') {
			this.#announcedBefore = this.#announced;
			this.#announced = entry.artistKey;
			this.#introVideo = track.videoId;
			saveSaid(this.#presenter.said);
		}
		if (this.caption && this.caption.artistKey !== entry.artistKey) this.caption = null;
		const since =
			this.#lastSpeechEnd === null ? undefined : (Date.now() - this.#lastSpeechEnd) / 1000;
		const plan = planSegment({ line, voice, sinceLastSpeechSeconds: since });
		this.#describe();

		if (plan.mode === 'beforeTrack') player.pause();
		const abort = new AbortController();
		this.#segment = abort;
		this.talking = plan.mode === 'beforeTrack';
		void runSegment(plan, {
			player,
			ducking,
			speak: (signal) => (line ? this.#say(line, signal) : Promise.resolve()),
			startTrack: () => {
				if (abort.signal.aborted) return;
				this.talking = false;
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
	 * Decides what's said before the next track while this one plays, so the live voice
	 * can render it ahead (Kokoro takes about as long to render a line as to say it).
	 * `#goTo` uses it if the radio does move on to that track, with nothing else changed.
	 */
	#planAhead(): void {
		const mode = this.settings.voiceMode;
		if (!this.#live.enabled || mode === 'off' || !this.queue.length) return;
		const pos = nextPosition(this.queue, this.position);
		const entry = this.queue[pos.artistIndex];
		const track = entry?.tracks[pos.trackIndex];
		if (!entry || !track || track.videoId === this.track?.videoId) return;
		const up = this.#upcoming;
		if (up && up.videoId === track.videoId && up.mode === mode && up.announced === this.#announced)
			return;
		const line = this.#presenter.forTrack({
			entry,
			trackIndex: pos.trackIndex,
			mode,
			now: new Date(),
			announcedArtistKey: this.#announced,
			clip: this.#clipFor(entry.artistKey)
		});
		this.#upcoming = {
			artistIndex: pos.artistIndex,
			trackIndex: pos.trackIndex,
			videoId: track.videoId,
			mode,
			announced: this.#announced,
			line
		};
		if (line) this.#speaker.prepare?.(line);
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
				done: false
			};
			if (this.#back.line) this.#speaker.prepare?.(this.#back.line);
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
			return;
		}
		const abort = new AbortController();
		back.abort = abort;
		const line = back.line;
		void runSegment(plan, {
			player,
			ducking,
			speak: (signal) => this.#say(line, signal),
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
		if (state !== 'playing') this.#cancelBack();
	}

	#onPlaying(): void {
		const player = this.#player;
		if (!player) return;
		this.#errors = 0;
		if (player.videoId === this.#introVideo) this.#introVideo = null;
		if (this.notice?.startsWith("Couldn't play")) this.notice = null;
		this.#scheduleBack();
		this.#planAhead();
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
		if (!this.started) {
			// Found while cueing, before any play: quietly move on to the next track.
			if (this.#errors >= MAX_ERRORS_IN_A_ROW) return;
			this.position = clampPosition(this.queue, nextPosition(this.queue, this.position));
			this.resumeAt = null;
			this.#cueIfIdle();
			this.#describe();
			return;
		}
		this.notice = `Couldn't play “${cleanSongTitle(track.title, entry.name)}” (${error.message ?? error.code}), skipping it.`;
		if (this.#errors >= MAX_ERRORS_IN_A_ROW) {
			this.#errors = 0;
			this.pause();
			this.notice =
				"Several tracks in a row wouldn't play. Check your connection, then press play.";
			return;
		}
		const next = nextPosition(this.queue, this.position);
		const nextTrack = this.queue[next.artistIndex]?.tracks[next.trackIndex];
		// Mid-intro and the next track is the same artist's: swap it in under the voice.
		if (
			this.#segment &&
			this.speaking &&
			next.artistIndex === this.position.artistIndex &&
			nextTrack
		) {
			this.position = { ...next, seconds: 0 };
			this.#introVideo = nextTrack.videoId;
			this.#describe();
			player.load(nextTrack);
			return;
		}
		// The intro was said over a track nobody heard: say it again for the next one.
		if (this.#introVideo === track.videoId) {
			this.#announced = this.#announcedBefore;
			this.#introVideo = null;
		}
		this.#goTo(next);
	}

	#tick(): void {
		const player = this.#player;
		if (!player) return;
		const state = player.state;
		if (
			this.resumeAt === null &&
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
