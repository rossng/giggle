<script lang="ts">
	import GigList from '$lib/components/GigList.svelte';
	import PosterTile from '$lib/components/PosterTile.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import { amsterdamDate } from '$lib/data/dates';
	import { GENRES, NO_GENRE_COLOUR, bucketsFor } from '$lib/data/genres';
	import type { GigView } from '$lib/data/catalog';

	let { data } = $props();
	const artist = $derived(data.artist);
	const mb = $derived(artist.musicbrainz);
	const today = amsterdamDate(new Date());

	const gigs = $derived(
		artist.gigs
			.map((id) => data.catalog.byId.get(id))
			.filter((v): v is GigView => !!v && v.date >= today)
			.sort((a, b) => a.gig.start.localeCompare(b.gig.start))
	);
	const tags = $derived([
		...new Set(
			[...(mb?.genres ?? []), ...(mb?.tags ?? []), ...(artist.lastfm?.tags ?? [])].map((t) =>
				t.toLowerCase()
			)
		)
	]);
	const bucket = $derived(bucketsFor(tags)[0] ?? gigs[0]?.primary ?? null);
	const colour = $derived(bucket ? GENRES[bucket].colour : NO_GENRE_COLOUR);
	const origin = $derived(
		[mb?.begin_area, mb?.area !== mb?.begin_area ? mb?.area : null].filter(Boolean).join(', ') ||
			mb?.country
	);
	const facts = $derived(
		[
			{ k: mb?.type === 'Person' ? 'Born' : 'Formed', v: mb?.begin?.slice(0, 4) },
			{ k: 'From', v: origin },
			{ k: 'Type', v: mb?.type },
			{ k: 'Listeners', v: artist.lastfm?.listeners?.toLocaleString('en-GB') }
		].filter((f): f is { k: string; v: string } => !!f.v)
	);
	const links = $derived(Object.entries(mb?.links ?? {}).filter(([k]) => k !== 'wikidata'));
</script>

<svelte:head><title>{artist.name} · giggle</title></svelte:head>

<SiteHeader />
<main class="page">
	<header class="hero">
		<PosterTile name={artist.name} {colour} thumb={artist.wikipedia?.thumbnail} size={180} />
		<div class="head">
			<p class="label">
				Artist{#if artist.match?.disambiguation}&ensp;·&ensp;{artist.match.disambiguation}{/if}
				{#if artist.match && artist.match.confidence === 'low'}
					<span class="unsure" title="The MusicBrainz match is a guess">· match unsure</span>
				{/if}
			</p>
			<h1 class="display big">{artist.name}</h1>
			{#if facts.length}
				<dl class="facts">
					{#each facts as f (f.k)}<div>
							<dt>{f.k}</dt>
							<dd>{f.v}</dd>
						</div>{/each}
				</dl>
			{/if}
			{#if tags.length}
				<ul class="tags">
					{#each tags.slice(0, 10) as t (t)}<li>{t}</li>{/each}
				</ul>
			{/if}
		</div>
	</header>

	{#if artist.wikipedia}
		<section class="about">
			<p>{artist.wikipedia.extract}</p>
			{#if artist.wikipedia.url}
				<a class="src" href={artist.wikipedia.url} rel="external noopener" target="_blank"
					>Wikipedia{artist.wikipedia.lang !== 'en' ? ` (${artist.wikipedia.lang})` : ''} ↗</a
				>
			{/if}
		</section>
	{:else if artist.lastfm?.bio}
		<section class="about">
			<p>{artist.lastfm.bio}</p>
			{#if artist.lastfm.url}
				<a class="src" href={artist.lastfm.url} rel="external noopener" target="_blank">Last.fm ↗</a
				>
			{/if}
		</section>
	{:else if !artist.match}
		<p class="muted">
			Not matched on MusicBrainz yet, so there's nothing more to say about them than the venue does.
		</p>
	{/if}

	{#if links.length}
		<p class="links">
			{#each links as [kind, url] (kind)}
				<a href={url} rel="external noopener" target="_blank">{kind} ↗</a>
			{/each}
		</p>
	{/if}

	{#if artist.top_tracks?.length}
		<section>
			<h2 class="label">Top tracks on Last.fm</h2>
			<ol class="tracks">
				{#each artist.top_tracks.slice(0, 5) as t, i (i)}<li>{t.title}</li>{/each}
			</ol>
		</section>
	{/if}

	<section>
		<h2 class="label">{gigs.length ? 'Upcoming gigs' : 'No upcoming gigs'}</h2>
		<GigList views={gigs} {today} />
	</section>

	{#if artist.lastfm?.similar?.length}
		<section>
			<h2 class="label">Similar on Last.fm</h2>
			<ul class="tags">
				{#each artist.lastfm.similar as s (s)}<li>{s}</li>{/each}
			</ul>
		</section>
	{/if}
</main>

<style>
	.hero {
		display: flex;
		gap: 24px;
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.head {
		display: flex;
		flex-direction: column;
		gap: 10px;
		flex: 1;
		min-width: 260px;
	}
	.big {
		font-size: clamp(48px, 9vw, 76px);
		line-height: 0.86;
	}
	.unsure {
		color: var(--amber);
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin: 0;
		font-size: 13px;
	}
	.facts div {
		display: flex;
		gap: 5px;
	}
	dt {
		color: var(--mute);
	}
	dd {
		margin: 0;
	}
	.about {
		max-width: 68ch;
		font-size: 15px;
		line-height: 1.55;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.src {
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	.muted {
		color: var(--mute);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		text-transform: capitalize;
	}
	.links a {
		color: var(--amber);
	}
	.tracks {
		margin: 8px 0 0;
		padding-left: 22px;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
