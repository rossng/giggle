// What the radio keeps in this browser: the listening session per station (to resume where
// you were), the play history, what the presenter has said, the songs YouTube wouldn't play
// here, and the listener's settings.
// All in localStorage via $lib/storage, so a blocked or full storage just means no memory.

import {
	parseHistory,
	parseSaid,
	parseSession,
	pruneHistory,
	pruneSaid,
	type PlayHistory,
	type RadioSession,
	type SaidMemory,
	type VoiceMode
} from '@giggle/radio-core';
import { browserStorage, readJson, writeJson, type KeyValueStorage } from '$lib/storage';

export const KEYS = {
	sessions: 'giggle:radio:sessions:v1',
	history: 'giggle:radio:history:v1',
	said: 'giggle:radio:said:v1',
	unplayable: 'giggle:radio:unplayable:v1',
	settings: 'giggle:radio:settings:v1'
} as const;

/** Sessions kept, newest first; older stations are forgotten. */
export const MAX_SESSIONS = 8;

export type Sessions = Record<string, RadioSession>;

export function parseSessions(value: unknown): Sessions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const out: Sessions = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const session = parseSession(raw);
		if (session && session.filtersKey === key) out[key] = session;
	}
	return out;
}

/** `sessions` with `session` stored under its station, keeping the newest `max`. */
export function putSession(
	sessions: Sessions,
	session: RadioSession,
	max = MAX_SESSIONS
): Sessions {
	const all = { ...sessions, [session.filtersKey]: session };
	const newest = Object.values(all)
		.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
		.slice(0, max);
	return Object.fromEntries(newest.map((s) => [s.filtersKey, s]));
}

export function loadSession(
	key: string,
	storage: KeyValueStorage | null = browserStorage()
): RadioSession | null {
	return parseSessions(readJson(KEYS.sessions, storage))[key] ?? null;
}

export function saveSession(
	session: RadioSession,
	storage: KeyValueStorage | null = browserStorage()
): boolean {
	const sessions = parseSessions(readJson(KEYS.sessions, storage));
	return writeJson(KEYS.sessions, putSession(sessions, session), storage);
}

export function loadHistory(now: Date, storage = browserStorage()): PlayHistory {
	return pruneHistory(parseHistory(readJson(KEYS.history, storage)), now);
}

export function saveHistory(history: PlayHistory, storage = browserStorage()): boolean {
	return writeJson(KEYS.history, history, storage);
}

export function loadSaid(now: Date, storage = browserStorage()): SaidMemory {
	return pruneSaid(parseSaid(readJson(KEYS.said, storage)), now);
}

export function saveSaid(said: SaidMemory, storage = browserStorage()): boolean {
	return writeJson(KEYS.said, said, storage);
}

/** Songs YouTube wouldn't play here (gone, or not allowed outside YouTube): video id → when
 * that was found. The radio leaves them out for a while, then tries again. */
export type Unplayable = Record<string, string>;

export const UNPLAYABLE_DAYS = 14;

export function parseUnplayable(value: unknown, now: Date): Unplayable {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const since = now.getTime() - UNPLAYABLE_DAYS * 86_400_000;
	const out: Unplayable = {};
	for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
		if (typeof at === 'string' && Date.parse(at) > since) out[id] = at;
	}
	return out;
}

export function loadUnplayable(now: Date, storage = browserStorage()): Unplayable {
	return parseUnplayable(readJson(KEYS.unplayable, storage), now);
}

export function saveUnplayable(unplayable: Unplayable, storage = browserStorage()): boolean {
	return writeJson(KEYS.unplayable, unplayable, storage);
}

export interface RadioSettings {
	voiceMode: VoiceMode;
	/** A Web Speech voice name (the fallback voice); null picks a British default. */
	voiceName: string | null;
	/** Who says the live lines: Kokoro in the browser, or the browser's own voice. */
	liveVoice: LiveVoice;
	tracksPerArtist: number;
	/** Listener's music volume, 0–100. */
	volume: number;
	/** Keep the screen from sleeping while the radio plays (wake-lock.ts). */
	keepScreenOn: boolean;
}

export type LiveVoice = 'kokoro' | 'browser';

export const DEFAULT_SETTINGS: Readonly<RadioSettings> = Object.freeze({
	voiceMode: 'short',
	voiceName: null,
	liveVoice: 'kokoro',
	tracksPerArtist: 2,
	volume: 100,
	keepScreenOn: false
});

export const TRACKS_PER_ARTIST = [1, 2, 3] as const;

export function parseSettings(value: unknown): RadioSettings {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<RadioSettings>;
	return {
		voiceMode:
			v.voiceMode === 'off' || v.voiceMode === 'name' || v.voiceMode === 'short'
				? v.voiceMode
				: DEFAULT_SETTINGS.voiceMode,
		voiceName: typeof v.voiceName === 'string' && v.voiceName ? v.voiceName : null,
		liveVoice:
			v.liveVoice === 'kokoro' || v.liveVoice === 'browser'
				? v.liveVoice
				: DEFAULT_SETTINGS.liveVoice,
		tracksPerArtist: (TRACKS_PER_ARTIST as readonly unknown[]).includes(v.tracksPerArtist)
			? (v.tracksPerArtist as number)
			: DEFAULT_SETTINGS.tracksPerArtist,
		volume:
			typeof v.volume === 'number' && Number.isFinite(v.volume)
				? Math.min(100, Math.max(0, Math.round(v.volume)))
				: DEFAULT_SETTINGS.volume,
		keepScreenOn:
			typeof v.keepScreenOn === 'boolean' ? v.keepScreenOn : DEFAULT_SETTINGS.keepScreenOn
	};
}

export function loadSettings(storage = browserStorage()): RadioSettings {
	return parseSettings(readJson(KEYS.settings, storage));
}

export function saveSettings(settings: RadioSettings, storage = browserStorage()): boolean {
	return writeJson(KEYS.settings, settings, storage);
}
