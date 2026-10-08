<!-- Who's on, under the video: the artist's name big (and how they're sorted), the song, their
     gigs on the station as tickets (each with how it's sorted), then whatever the page puts there
     (the sort row), and more about them on request. -->
<script lang="ts">
	import type { QueueEntry, Track } from '@giggle/radio-core';
	import type { Snippet } from 'svelte';
	import TicketStrip from './TicketStrip.svelte';
	import { TRIAGE_LABELS, type Triage } from '$lib/board/board';
	import { boardStore } from '$lib/board/board-store.svelte';
	import type { GigView } from '$lib/data/catalog';
	import { artistPath } from '$lib/data/slugs';
	import type { Artist, IsoDate } from '$lib/data/types';
	import { youtubeMusicUrl } from '$lib/radio/tracks';

	let {
		entry,
		track,
		trackIndex,
		artist,
		views,
		today,
		triage = null,
		actions
	}: {
		entry: QueueEntry;
		track: Track;
		trackIndex: number;
		artist: Artist | undefined;
		/** Their gigs on the station, soonest first. */
		views: readonly GigView[];
		today: IsoDate;
		/** How the artist is sorted (listen more, not for me). */
		triage?: Triage | null;
		/** Under the ticket: the sort row. */
		actions?: Snippet;
	} = $props();

	const mb = $derived(artist?.musicbrainz ?? null);
	const isGroup = $derived(['Group', 'Orchestra', 'Choir'].includes(mb?.type ?? ''));

	const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
	const listeners = $derived.by(() => {
		const yt = artist?.youtube?.monthlyListeners;
		if (typeof yt === 'string' && yt.trim())
			return { value: yt.trim(), label: 'Monthly listeners' };
		if (typeof yt === 'number' && yt > 0)
			return { value: compact.format(yt), label: 'Monthly listeners' };
		const lfm = artist?.lastfm?.listeners;
		return lfm ? { value: compact.format(lfm), label: 'Last.fm listeners' } : null;
	});

	const others = $derived(
		entry.gig.artists.filter((a) => a.key !== entry.artistKey).map((a) => a.name)
	);
	const facts = $derived(
		[
			mb?.begin_area || mb?.area
				? { label: 'From', value: (mb.begin_area || mb.area) as string }
				: null,
			isGroup && mb?.begin ? { label: 'Formed', value: mb.begin.slice(0, 4) } : null,
			listeners ? { label: listeners.label, value: listeners.value } : null,
			others.length
				? {
						label: entry.role === 'support' ? 'Supporting' : 'With',
						value:
							others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '')
					}
				: null
		].filter((f): f is { label: string; value: string } => f !== null)
	);

	const tags = $derived.by(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of [
			...(mb?.genres ?? []),
			...(artist?.lastfm?.tags ?? []),
			...(views[0]?.gig.genres ?? [])
		]) {
			const tag = raw.toLowerCase().trim();
			if (!tag || seen.has(tag) || tag === 'seen live' || /^\d{4}s?$/.test(tag)) continue;
			seen.add(tag);
			out.push(tag);
			if (out.length === 6) break;
		}
		return out;
	});

	const about = $derived(artist?.wikipedia?.extract || artist?.youtube?.description || '');
	/** One line about them: the announcer's blurb, else the start of the bio. */
	const line = $derived(artist?.blurbs?.[0] ?? '');
</script>

<section class="np" aria-label="Now playing">
	<p class="eyebrow">
		Now playing · track {trackIndex + 1} of {entry.tracks.length}
		{#if triage}<span class="badge b-{triage}">{TRIAGE_LABELS[triage]}</span>{/if}
	</p>
	<h1 class="artist">
		{#if artist}<a href={artistPath(artist)}>{entry.name}</a>{:else}{entry.name}{/if}
	</h1>
	<p class="track ellipsis">
		{track.title}{#if track.album && track.album !== track.title}<span class="album"
				>{' · '}{track.album}</span
			>{/if}
	</p>
	{#each views as view (view.id)}
		<TicketStrip
			{view}
			{today}
			artistKey={entry.artistKey}
			youtubeMusic={youtubeMusicUrl(artist?.youtube)}
			mark={boardStore.gigState(view.id)}
		/>
	{/each}
	{@render actions?.()}
	{#if line || facts.length || tags.length || about}
		<details class="more">
			<summary>
				{#if line}<span class="line">{line[0]?.toUpperCase()}{line.slice(1)}.</span>{/if}
				<span class="open">More about {entry.name}</span>
			</summary>
			{#if facts.length}
				<dl class="facts">
					{#each facts as fact (fact.label)}
						<div>
							<dt>{fact.label}</dt>
							<dd>{fact.value}</dd>
						</div>
					{/each}
				</dl>
			{/if}
			{#if tags.length}
				<ul class="tags">
					{#each tags as tag (tag)}<li>{tag}</li>{/each}
				</ul>
			{/if}
			{#if about}<p class="about">{about}</p>{/if}
			{#if artist}<a class="page" href={artistPath(artist)}>{entry.name}'s page →</a>{/if}
		</details>
	{/if}
</section>

<style>
	.np {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	.eyebrow {
		margin: 0;
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--amber);
		display: flex;
		gap: 10px;
		align-items: center;
		/* As tall as the sort badge, so sorting the artist doesn't move the page. */
		min-height: 16px;
	}
	.artist {
		margin: 0;
		font: 800 clamp(40px, 5.2vw, 72px) / 0.88 var(--f-display);
		text-transform: uppercase;
		letter-spacing: -0.005em;
		overflow-wrap: anywhere;
	}
	.artist a {
		text-decoration: none;
	}
	.artist a:hover {
		text-decoration: underline;
		text-decoration-thickness: 3px;
	}
	.track {
		margin: -4px 0 0;
		font-size: 16px;
		color: var(--mute);
	}
	.album {
		font-size: 13px;
	}
	.more summary {
		cursor: pointer;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: #cfc8dc;
		font-size: 14px;
	}
	.more summary::-webkit-details-marker {
		display: none;
	}
	.open {
		color: var(--mute);
		font-size: 12.5px;
	}
	.open::after {
		content: ' ▾';
	}
	.more[open] .open::after {
		content: ' ▴';
	}
	.more[open] {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		margin: 6px 0 0;
		font-size: 12.5px;
	}
	.facts div {
		display: flex;
		gap: 5px;
	}
	.facts dt {
		color: var(--mute);
	}
	.facts dd {
		margin: 0;
		font-weight: 600;
	}
	.about {
		margin: 0;
		font-size: 13.5px;
		color: #cfc8dc;
		line-height: 1.5;
	}
	.page {
		color: var(--amber);
		font-size: 13px;
		text-decoration: none;
	}
</style>
