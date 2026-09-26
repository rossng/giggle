<script lang="ts">
	import PosterTile from '$lib/components/PosterTile.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import { amsterdamDate, dayParts, localTime, relativeDays } from '$lib/data/dates';
	import { GENRES } from '$lib/data/genres';
	import { artistPath, venuePath } from '$lib/data/slugs';
	import type { Availability } from '$lib/data/types';

	let { data } = $props();
	const view = $derived(data.view);
	const gig = $derived(view.gig);
	const artists = $derived(data.catalog.artists);
	const today = amsterdamDate(new Date());
	const day = $derived(dayParts(view.date));

	const AVAILABILITY: Record<Availability, string | null> = {
		unknown: null,
		on_sale: 'On sale',
		few_left: 'Few tickets left',
		sold_out: 'Sold out',
		free: 'Free entry',
		not_yet_on_sale: 'Not on sale yet'
	};

	const times = $derived(
		[
			gig.doors && `doors ${localTime(gig.doors)}`,
			`starts ${view.time}`,
			gig.end && `ends ${localTime(gig.end)}`
		].filter(Boolean)
	);
	const extra = $derived(
		Object.entries(gig.extra ?? {}).map(([k, v]) => [
			k,
			typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
				? String(v)
				: JSON.stringify(v)
		])
	);
</script>

<svelte:head><title>{gig.title} · {view.venueName} · giggle</title></svelte:head>

<SiteHeader />
<main class="page">
	<header class="hero">
		<PosterTile name={view.headliner} colour={view.colour} thumb={view.thumb} size={180} />
		<div class="head">
			<p class="label">
				Gig{#if gig.status !== 'scheduled'}&ensp;·&ensp;<span class="warn">{gig.status}</span>{/if}
				{#if gig.lineup.kind === 'festival'}&ensp;·&ensp;festival{/if}
			</p>
			<h1 class="display big">{gig.title}</h1>
			{#if gig.subtitle}<p class="subtitle">{gig.subtitle}</p>{/if}

			<div class="ticket">
				<div class="t-date">
					<b>{day.day}</b><span>{day.month}</span>
				</div>
				<div class="t-body">
					<a class="t-venue" href={venuePath(gig.venue)}
						>{view.venueName}{gig.room ? ` · ${gig.room}` : ''}</a
					>
					<span class="t-meta">
						{day.weekday}
						{day.day}
						{day.month}
						{day.year} · {times.join(' · ')} · {relativeDays(view.date, today)}
					</span>
					<span class="t-meta">
						{view.cityName}
						{#if view.price}· {view.price}{/if}
						{#if AVAILABILITY[gig.availability]}
							· <span class:warn={view.soldOut}>{AVAILABILITY[gig.availability]}</span>
						{/if}
					</span>
					{#if gig.price?.text && gig.price.text !== view.price}
						<span class="t-meta">{gig.price.text}</span>
					{/if}
				</div>
				{#if gig.ticket_url || gig.url}
					<a class="t-link" href={gig.ticket_url ?? gig.url} rel="external noopener" target="_blank"
						>Tickets ↗</a
					>
				{/if}
			</div>
		</div>
	</header>

	{#if gig.artists.length}
		<section>
			<h2 class="label">Line-up</h2>
			<ul class="artists">
				{#each gig.artists as ref (ref.key)}
					{@const artist = artists[ref.key]}
					<li>
						<a href={artistPath(artist ?? ref)}>{artist?.name ?? ref.name}</a>
						<span class="role">{ref.role}</span>
						{#if artist?.musicbrainz}
							<span class="muted"
								>{[
									artist.musicbrainz.begin_area ?? artist.musicbrainz.area,
									artist.musicbrainz.begin?.slice(0, 4)
								]
									.filter(Boolean)
									.join(' · ')}</span
							>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="muted small">
				Line-up read from the listing ({gig.lineup.source === 'fake'
					? 'title rules'
					: gig.lineup.source}).
			</p>
		</section>
	{/if}

	{#if gig.genres.length || view.buckets.length}
		<section>
			<h2 class="label">Genre</h2>
			<ul class="tags">
				{#each view.buckets as b (b)}
					<li><span class="dot" style:background={GENRES[b].colour}></span>{GENRES[b].label}</li>
				{/each}
				{#each gig.genres as g (g)}<li>{g}</li>{/each}
			</ul>
		</section>
	{/if}

	{#if gig.description}
		<section class="about">
			<h2 class="label">From the venue</h2>
			<p>{gig.description}</p>
		</section>
	{/if}

	{#if gig.image}
		<img class="image" src={gig.image} alt="" loading="lazy" referrerpolicy="no-referrer" />
	{/if}

	<section>
		<h2 class="label">Details</h2>
		<dl class="details">
			{#if gig.url}<div>
					<dt>Listing</dt>
					<dd><a href={gig.url} rel="external noopener" target="_blank">{gig.url}</a></dd>
				</div>{/if}
			{#if gig.categories.length}<div>
					<dt>Categories</dt>
					<dd>{gig.categories.join(', ')}</dd>
				</div>{/if}
			{#if gig.performers.length}<div>
					<dt>Performers</dt>
					<dd>{gig.performers.join(', ')}</dd>
				</div>{/if}
			{#if gig.support.length}<div>
					<dt>Support</dt>
					<dd>{gig.support.join(', ')}</dd>
				</div>{/if}
			{#if gig.place !== gig.venue}<div>
					<dt>At</dt>
					<dd>{data.catalog.venues[gig.place]?.name ?? gig.place}</dd>
				</div>{/if}
			{#each extra as [k, v] (k)}<div>
					<dt>{k.replaceAll('_', ' ')}</dt>
					<dd>{v}</dd>
				</div>{/each}
			<div>
				<dt>ID</dt>
				<dd><code>{gig.id}</code></dd>
			</div>
		</dl>
	</section>
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
		min-width: min(100%, 300px);
	}
	.big {
		font-size: clamp(40px, 8vw, 68px);
		line-height: 0.88;
		overflow-wrap: anywhere;
	}
	.subtitle {
		font-size: 15px;
		color: var(--mute);
	}
	.warn {
		color: var(--bad);
	}
	.ticket {
		display: flex;
		align-items: stretch;
		background: var(--p2);
		border-radius: 8px;
		overflow: hidden;
		margin-top: 4px;
	}
	.t-date {
		width: 62px;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-right: 1px dashed var(--line);
		padding: 8px 0;
	}
	.t-date b {
		font: 800 28px/0.9 var(--f-display);
		color: var(--amber);
	}
	.t-date span {
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--mute);
	}
	.t-body {
		padding: 9px 14px;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.t-venue {
		font-weight: 650;
		font-size: 14px;
		text-decoration: none;
	}
	.t-venue:hover {
		text-decoration: underline;
	}
	.t-meta {
		font-size: 12px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
	}
	.t-link {
		align-self: center;
		margin-right: 14px;
		color: var(--amber);
		font-weight: 650;
		font-size: 13px;
		white-space: nowrap;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.artists {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.artists li {
		display: flex;
		gap: 10px;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.artists a {
		font: 800 24px/1 var(--f-display);
		text-transform: uppercase;
		text-decoration: none;
	}
	.artists a:hover {
		color: var(--amber);
	}
	.role {
		font: 600 10px var(--f-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--mute);
	}
	.muted {
		color: var(--mute);
		font-size: 12.5px;
	}
	.small {
		font-size: 11.5px;
	}
	.about p {
		max-width: 70ch;
		font-size: 14.5px;
		line-height: 1.6;
		white-space: pre-line;
	}
	.image {
		max-width: min(100%, 560px);
		border-radius: 10px;
	}
	.details {
		margin: 0;
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 6px 16px;
		font-size: 13px;
	}
	.details div {
		display: contents;
	}
	dt {
		color: var(--mute);
		text-transform: capitalize;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--f-mono);
		font-size: 12px;
	}
</style>
