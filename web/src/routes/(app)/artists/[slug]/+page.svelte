<script lang="ts">
	// One artist. Up front: who they are in a line, playing them, sorting them (listen more, not for
	// me: plans are each gig's, on its page), and their upcoming gigs. The bio, facts, tags, links, top tracks and similar artists are under
	// "More about …".
	import GigList from '$lib/components/GigList.svelte';
	import PosterTile from '$lib/components/PosterTile.svelte';
	import More from '$lib/components/pages/More.svelte';
	import PlayArtist from '$lib/components/pages/PlayArtist.svelte';
	import TriageButtons from '$lib/components/TriageButtons.svelte';
	import { ARTIST_TRIAGES, isArtistTriage } from '$lib/board/board';
	import { boardStore } from '$lib/board/board-store.svelte';
	import { amsterdamDate } from '$lib/data/dates';
	import { GENRES, NO_GENRE_COLOUR, bucketsFor } from '$lib/data/genres';
	import type { GigView } from '$lib/data/catalog';
	import { artistPath, externalHref } from '$lib/data/slugs';
	import { youtubeMusicUrl } from '$lib/radio/tracks';

	let { data } = $props();
	const catalog = $derived(data.catalog);
	const artist = $derived(data.artist);
	const mb = $derived(artist.musicbrainz);
	const today = amsterdamDate(new Date());

	const gigs = $derived(
		artist.gigs
			.map((id) => catalog.byId.get(id))
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
	const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
	/** Who they are, in a line: the announcer's descriptor, else Wikipedia's, else their tags. */
	const line = $derived(
		artist.blurbs?.[0]
			? capitalise(artist.blurbs[0].replace(/[.…]*$/, ''))
			: artist.wikipedia?.description
				? capitalise(artist.wikipedia.description)
				: tags.length
					? capitalise(tags.slice(0, 3).join(' · '))
					: null
	);
	const since = $derived(mb?.begin?.slice(0, 4));
	const facts = $derived(
		[
			{ k: mb?.type === 'Person' ? 'Born' : 'Formed', v: since },
			{ k: 'From', v: origin },
			{ k: 'Type', v: mb?.type },
			{ k: 'Last.fm listeners', v: artist.lastfm?.listeners?.toLocaleString('en-GB') },
			{
				k: 'YouTube Music',
				v: artist.youtube?.monthlyListeners ? `${artist.youtube.monthlyListeners} monthly` : null
			}
		].filter((f): f is { k: string; v: string } => !!f.v)
	);
	const bio = $derived(
		artist.wikipedia
			? {
					text: artist.wikipedia.extract,
					url: externalHref(artist.wikipedia.url),
					source: `Wikipedia${artist.wikipedia.lang !== 'en' ? ` (${artist.wikipedia.lang})` : ''}`
				}
			: artist.lastfm?.bio
				? { text: artist.lastfm.bio, url: externalHref(artist.lastfm.url), source: 'Last.fm' }
				: null
	);
	const links = $derived(
		[
			...Object.entries(mb?.links ?? {}).filter(([k]) => k !== 'wikidata' && k !== 'wikipedia'),
			['YouTube Music', youtubeMusicUrl(artist.youtube)] as const
		]
			.map(([kind, url]) => [kind, externalHref(url)] as const)
			.filter((l): l is readonly [string, string] => !!l[1])
	);
	/** Similar artists who are in the data too get a link. */
	const byName = $derived(
		new Map(Object.values(catalog.artists).map((a) => [a.name.toLowerCase(), a]))
	);
	const similar = $derived(
		[
			...new Map((artist.lastfm?.similar ?? []).map((name) => [name.toLowerCase(), name])).values()
		].map((name) => ({ name, artist: byName.get(name.toLowerCase()) }))
	);
	const moreSummary = $derived(
		[
			bio && 'bio',
			facts.length && 'facts',
			tags.length && 'tags',
			links.length && 'links',
			artist.top_tracks?.length && 'top tracks',
			similar.length && 'similar artists'
		]
			.filter(Boolean)
			.join(' · ')
	);
	const sorted = $derived(boardStore.artistState(artist.key));
</script>

<svelte:head><title>{artist.name} · giggle</title></svelte:head>

<main class="page artist">
	<header class="hero">
		<PosterTile name={artist.name} {colour} thumb={artist.wikipedia?.thumbnail} size={148} />
		<div class="head">
			<p class="label">
				Artist{#if origin}&ensp;·&ensp;{origin}{/if}{#if since}&ensp;·&ensp;{since}{/if}
				{#if artist.match && artist.match.confidence === 'low'}
					<span class="unsure" title="The MusicBrainz match is a guess">· match unsure</span>
				{/if}
			</p>
			<h1 class="display title">{artist.name}</h1>
			{#if line}<p class="line">{line}</p>{/if}
		</div>
	</header>

	<div class="actions">
		<PlayArtist {catalog} artistKey={artist.key} name={artist.name} strong />
		<TriageButtons
			label="Sort {artist.name}"
			states={ARTIST_TRIAGES}
			current={sorted ? [sorted] : []}
			onpick={(t) => isArtistTriage(t) && boardStore.toggleArtist(artist, t)}
		/>
	</div>

	<section>
		<h2 class="label">
			{gigs.length
				? `${gigs.length} upcoming gig${gigs.length === 1 ? '' : 's'}`
				: 'No upcoming gigs'}
		</h2>
		{#if gigs.length}
			<GigList views={gigs} {today} />
		{:else}
			<p class="muted">Nothing in the listings right now.</p>
		{/if}
	</section>

	{#if moreSummary}
		<div>
			<More label="More about {artist.name}" summary={moreSummary}>
				{#if bio}
					<div class="bio">
						<p>{bio.text}</p>
						{#if bio.url}
							<a class="src" href={bio.url} rel="external noopener" target="_blank"
								>{bio.source} ↗</a
							>
						{/if}
					</div>
				{/if}
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
						{#each tags.slice(0, 12) as t (t)}<li>{t}</li>{/each}
					</ul>
				{/if}
				{#if links.length}
					<p class="links">
						{#each links as [kind, url] (kind)}
							<a href={url} rel="external noopener" target="_blank">{kind} ↗</a>
						{/each}
					</p>
				{/if}
				{#if artist.top_tracks?.length || similar.length}
					<div class="cols">
						{#if artist.top_tracks?.length}
							<section>
								<h3 class="label">Top tracks on Last.fm</h3>
								<ol class="tracks">
									{#each artist.top_tracks.slice(0, 5) as t, i (i)}<li>{t.title}</li>{/each}
								</ol>
							</section>
						{/if}
						{#if similar.length}
							<section>
								<h3 class="label">Similar on Last.fm</h3>
								<ul class="tags">
									{#each similar as s (s.name.toLowerCase())}
										<li>
											{#if s.artist}<a href={artistPath(s.artist)}>{s.name}</a>{:else}{s.name}{/if}
										</li>
									{/each}
								</ul>
							</section>
						{/if}
					</div>
				{/if}
			</More>
		</div>
	{:else if !artist.match}
		<p class="muted">
			Not matched on MusicBrainz yet, so there's nothing more to say about them than the venue does.
		</p>
	{/if}
</main>

<style>
	.artist {
		gap: 18px;
	}
	.hero {
		display: flex;
		gap: 20px;
		align-items: flex-end;
	}
	.head {
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}
	.title {
		font-size: clamp(36px, 6vw, 60px);
		overflow-wrap: break-word;
	}
	.line {
		font-size: 15px;
		color: var(--mute);
		max-width: 60ch;
	}
	.unsure {
		color: var(--amber);
	}
	.actions {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 8px;
		align-items: center;
		max-width: 760px;
	}
	/* No songs, no play button: the sort buttons take the row. */
	.actions > :global(.triage:first-child) {
		grid-column: 1 / -1;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.muted {
		color: var(--mute);
	}
	.bio {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 68ch;
		font-size: 14.5px;
		line-height: 1.6;
	}
	.src {
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 10px 16px;
		margin: 0;
		font-size: 13px;
	}
	.facts div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	dt {
		color: var(--mute);
		font-size: 11.5px;
	}
	dd {
		margin: 0;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 16px;
		text-transform: capitalize;
	}
	.links a {
		color: var(--amber);
		white-space: nowrap;
	}
	.tags a {
		color: var(--ink);
		text-decoration: none;
	}
	.tags a:hover {
		text-decoration: underline;
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 18px 28px;
	}
	.tracks {
		margin: 0;
		padding-left: 22px;
	}

	@media (max-width: 700px) {
		.hero {
			gap: 14px;
		}
		.hero > :global(.poster) {
			--poster-size: 88px;
		}
		.actions {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (pointer: coarse) {
		.links a {
			padding: 10px 0;
		}
	}
</style>
