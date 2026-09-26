import { describe, expect, it } from 'vitest';
import { snapshotSession } from '@giggle/radio-core';
import { memoryStorage } from '$lib/storage';
import {
	DEFAULT_SETTINGS,
	KEYS,
	loadHistory,
	loadSession,
	parseSessions,
	parseSettings,
	putSession,
	saveHistory,
	saveSession
} from './persist';

const session = (key: string, at: string, artistIndex = 0) =>
	snapshotSession({
		filtersKey: key,
		seed: 7,
		order: 'mix',
		queue: ['a', 'b', 'c'],
		position: { artistIndex, trackIndex: 1, seconds: 83.5 },
		now: new Date(at)
	});

describe('sessions', () => {
	it('keeps one session per station, newest first, up to the limit', () => {
		let all = {};
		all = putSession(all, session('s1', '2026-09-26T10:00:00Z'), 2);
		all = putSession(all, session('s2', '2026-09-26T11:00:00Z'), 2);
		all = putSession(all, session('s1', '2026-09-26T12:00:00Z', 2), 2);
		all = putSession(all, session('s3', '2026-09-26T13:00:00Z'), 2);
		expect(Object.keys(all).sort()).toEqual(['s1', 's3']);
	});

	it('round-trips through storage and ignores junk', () => {
		const storage = memoryStorage();
		expect(loadSession('s1', storage)).toBeNull();
		expect(saveSession(session('s1', '2026-09-26T10:00:00Z', 2), storage)).toBe(true);
		expect(loadSession('s1', storage)?.position).toEqual({
			artistIndex: 2,
			trackIndex: 1,
			seconds: 83.5
		});
		expect(
			parseSessions({ s1: { version: 99 }, s2: session('other', '2026-09-26T10:00:00Z') })
		).toEqual({});
		storage.setItem(KEYS.sessions, 'garbage');
		expect(loadSession('s1', storage)).toBeNull();
	});
});

describe('history', () => {
	it('round-trips and prunes old plays', () => {
		const storage = memoryStorage();
		const now = new Date('2026-09-26T12:00:00Z');
		saveHistory({ a: [now.getTime()], old: [Date.parse('2026-01-01T00:00:00Z')] }, storage);
		expect(loadHistory(now, storage)).toEqual({ a: [now.getTime()] });
	});
});

describe('settings', () => {
	it('fills in defaults and rejects bad values', () => {
		expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(
			parseSettings({ voiceMode: 'name', voiceName: 'Daniel', tracksPerArtist: 3, volume: 140 })
		).toEqual({ voiceMode: 'name', voiceName: 'Daniel', tracksPerArtist: 3, volume: 100 });
		expect(parseSettings({ voiceMode: 'loud', tracksPerArtist: 9, volume: 'x' })).toEqual(
			DEFAULT_SETTINGS
		);
	});
});
