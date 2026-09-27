// The app's sections, in the order people use them: see what's on, listen, keep track.
import { toQuery } from '$lib/data/filters';
import { stationQuery, type Station } from '$lib/radio/station';

export interface Section {
	path: string;
	label: string;
	href: string;
}

/** Radio and Agenda carry the station's filters, so a station and its list stay in step. */
export function sections(station: Station): Section[] {
	return [
		{ path: '/agenda', label: 'Agenda', href: `/agenda${toQuery(station.filters)}` },
		{ path: '/radio', label: 'Radio', href: `/radio${stationQuery(station)}` },
		{ path: '/board', label: 'Board', href: '/board' }
	];
}

export function isCurrent(pathname: string, path: string): boolean {
	return pathname === path || pathname.startsWith(`${path}/`);
}
