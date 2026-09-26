<!-- Who's on: poster/photo, song, the artist's name big, their gig as a ticket, a few facts. -->
<script lang="ts">
	import type { QueueEntry, Track } from '@giggle/radio-core';
	import PosterTile from '$lib/components/PosterTile.svelte';
	import TicketStrip from './TicketStrip.svelte';
	import { TRIAGE_LABELS, type Triage } from '$lib/board/board';
	import type { GigView } from '$lib/data/catalog';
	import { NO_GENRE_COLOUR } from '$lib/data/genres';
	import { artistPath } from '$lib/data/slugs';
	import type { Artist, IsoDate } from '$lib/data/types';
	import { artistImage, squareImage, youtubeMusicUrl } from '$lib/radio/tracks';

	let {
		entry,
		track,
		trackIndex,
		artist,
		view,
		today,
		triage = null
	}: {
		entry: QueueEntry;
		track: Track;
		trackIndex: number;
		artist: Artist | undefined;
		view: GigView | undefined;
		today: IsoDate;
		triage?: Triage | null;
	} = $props();

	const colour = $derived(view?.colour ?? NO_GENRE_COLOUR);
	const image = $derived(squareImage(artistImage(artist), 480));
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
			...(entry.gig.genres ?? [])
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
	let open = $state(false);
</script>

<section class="np" aria-label="Now playing">
	<div class="art">
		{#key entry.artistKey}
			<PosterTile name={entry.name} {colour} thumb={image} size={200} />
		{/key}
	</div>
	<div class="info">
		<p class="eyebrow">
			Now playing · track {trackIndex + 1} of {entry.tracks.length}
			{#if triage}<span class="badge b-{triage}">{TRIAGE_LABELS[triage]}</span>{/if}
		</p>
		<p class="track">
			{track.title}
			{#if track.album && track.album !== track.title}
				<span class="album">· {track.album}</span>
			{/if}
		</p>
		<h1 class="artist">
			{#if artist}<a href={artistPath(artist)}>{entry.name}</a>{:else}{entry.name}{/if}
		</h1>
		{#if view}
			<TicketStrip {view} {today} youtubeMusic={youtubeMusicUrl(artist?.youtube)} />
		{/if}
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
		{#if about}
			<button type="button" class="about" class:open onclick={() => (open = !open)}>{about}</button>
		{/if}
	</div>
</section>

<style>
	.np {
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr);
		gap: 22px;
		align-items: start;
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: 9px;
		min-width: 0;
	}
	.eyebrow {
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--amber);
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}
	.track {
		font-size: 16px;
		color: var(--mute);
	}
	.album {
		font-size: 13px;
	}
	.artist {
		font: 800 clamp(40px, 5.6vw, 76px) / 0.86 var(--f-display);
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
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		margin: 0;
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
		all: unset;
		cursor: pointer;
		font-size: 13px;
		color: #cfc8dc;
		max-width: 70ch;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.about.open {
		-webkit-line-clamp: unset;
		line-clamp: unset;
	}
	.about:focus-visible {
		outline: 2px solid var(--amber);
	}
	@media (max-width: 700px) {
		.np {
			grid-template-columns: minmax(0, 1fr);
		}
		.art {
			display: none;
		}
	}
</style>
