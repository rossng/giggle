<script lang="ts">
	// One gig. Up front: who, when, where, what it costs and where to get tickets, playing them on
	// the radio, and the line-up. The venue's own blurb is cut to a few lines; everything else the
	// listing says (genres, its picture, categories, raw fields) is under "More about this gig".
	import PosterTile from '$lib/components/PosterTile.svelte';
	import More from '$lib/components/pages/More.svelte';
	import PlayArtist from '$lib/components/pages/PlayArtist.svelte';
	import ReadMore from '$lib/components/pages/ReadMore.svelte';
	import { TRIAGE_LABELS } from '$lib/board/board';
	import { liveBoard } from '$lib/board/live';
	import { amsterdamDate, dayParts, localTime, relativeDays } from '$lib/data/dates';
	import { GENRES } from '$lib/data/genres';
	import { artistPath, venuePath } from '$lib/data/slugs';
	import type { Availability } from '$lib/data/types';

	let { data } = $props();
	const catalog = $derived(data.catalog);
	const view = $derived(data.view);
	const gig = $derived(view.gig);
	const artists = $derived(catalog.artists);
	const board = $derived(liveBoard(catalog));
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

	const when = $derived(
		[
			gig.doors && `doors ${localTime(gig.doors)}`,
			`${gig.doors ? 'starts ' : ''}${view.time}`,
			gig.end && `ends ${localTime(gig.end)}`
		]
			.filter(Boolean)
			.join(' · ')
	);
	const where = $derived(
		[gig.room, view.city !== 'amsterdam' ? view.cityName : null].filter(Boolean).join(' · ')
	);
	/** Worth a mention next to the price: few left, not on sale yet, free. */
	const availability = $derived(
		view.soldOut || gig.availability === 'on_sale' ? null : AVAILABILITY[gig.availability]
	);
	const tickets = $derived(gig.ticket_url ?? gig.url);
	/** The act the big play button plays: the first with songs, headliners first. */
	const playable = $derived(
		[...gig.artists]
			.sort((a, b) => Number(a.role !== 'headliner') - Number(b.role !== 'headliner'))
			.find((a) => artists[a.key]?.youtube?.songs?.length)
	);

	const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

	function origin(key: string): string {
		const mb = artists[key]?.musicbrainz;
		return [mb?.begin_area ?? mb?.area, mb?.begin?.slice(0, 4)].filter(Boolean).join(' · ');
	}

	const extra = $derived(
		Object.entries(gig.extra ?? {}).map(([k, v]) => [
			k,
			typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
				? String(v)
				: JSON.stringify(v)
		])
	);
	const genres = $derived([
		...view.buckets.map((b) => ({ key: b, label: GENRES[b].label, colour: GENRES[b].colour })),
		...gig.genres.map((g) => ({ key: g, label: g, colour: null }))
	]);
	const moreSummary = $derived(
		[genres.length && 'genre', gig.image && 'picture', gig.url && 'listing', 'details']
			.filter(Boolean)
			.join(' · ')
	);
</script>

<svelte:head><title>{gig.title} · {view.venueName} · giggle</title></svelte:head>

<main class="page gig">
	<header class="hero">
		<PosterTile name={view.headliner} colour={view.colour} thumb={view.thumb} size={148} />
		<div class="head">
			<p class="label">
				Gig{#if gig.lineup.kind === 'festival'}&ensp;·&ensp;festival{/if}{#if gig.status !== 'scheduled'}&ensp;·&ensp;<span
						class="warn">{gig.status}</span
					>{/if}
			</p>
			<h1 class="display title">{gig.title}</h1>
			{#if gig.subtitle}<p class="subtitle">{gig.subtitle}</p>{/if}
		</div>
	</header>

	<div class="ticket">
		<div class="t-date" aria-hidden="true">
			<span>{day.weekday}</span><b>{day.day}</b><span>{day.month}</span>
		</div>
		<div class="t-body">
			<a class="t-venue" href={venuePath(gig.venue)}>{view.venueName}</a>
			{#if where}<span class="t-line">{where}</span>{/if}
			<span class="t-line">{when}</span>
		</div>
		<div class="t-side">
			<b class:warn={view.soldOut}>{view.soldOut ? 'Sold out' : (view.price ?? '')}</b>
			<span class:note={availability}>{availability ?? relativeDays(view.date, today)}</span>
		</div>
	</div>

	<div class="actions">
		{#if tickets}
			<a
				class="button"
				class:strong={!view.soldOut}
				href={tickets}
				rel="external noopener"
				target="_blank"
				>{view.soldOut ? 'Resale & listing' : gig.ticket_url ? 'Tickets' : 'Listing'} ↗</a
			>
		{/if}
		{#if playable}
			<PlayArtist {catalog} artistKey={playable.key} name={playable.name} />
		{/if}
	</div>

	{#if gig.artists.length}
		<section class="lineup">
			<h2 class="label">Line-up</h2>
			<ul>
				{#each gig.artists as ref (ref.key)}
					{@const artist = artists[ref.key]}
					{@const state = board[ref.key]?.state}
					<li>
						<div class="act">
							<a href={artistPath(artist ?? ref)}>{artist?.name ?? ref.name}</a>
							<span class="meta">
								<span class="role">{ref.role}</span>
								{#if origin(ref.key)}<span>{origin(ref.key)}</span>{/if}
								{#if state}<span class="badge b-{state}">{TRIAGE_LABELS[state]}</span>{/if}
							</span>
						</div>
						<PlayArtist {catalog} artistKey={ref.key} name={ref.name} compact />
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if gig.description}
		<section>
			<h2 class="label">From the venue</h2>
			<ReadMore text={gig.description} lines={4} />
		</section>
	{/if}

	<div>
		<More label="More about this gig" summary={moreSummary}>
			{#if genres.length}
				<ul class="tags">
					{#each genres as g (g.key)}
						<li>
							{#if g.colour}<span class="dot" style:background={g.colour}></span>{/if}{g.label}
						</li>
					{/each}
				</ul>
			{/if}
			{#if gig.image}
				<img class="image" src={gig.image} alt="" loading="lazy" referrerpolicy="no-referrer" />
			{/if}
			<dl class="details">
				{#if gig.url}<div>
						<dt>Listing</dt>
						<dd>
							<a href={gig.url} rel="external noopener" target="_blank"
								>{gig.url.replace(/^https?:\/\/(www\.)?/, '')}</a
							>
						</dd>
					</div>{/if}
				<div>
					<dt>When</dt>
					<dd>{day.weekday} {day.day} {day.month} {day.year}, {relativeDays(view.date, today)}</dd>
				</div>
				{#if gig.price?.text && gig.price.text !== view.price}<div>
						<dt>Price</dt>
						<dd>{gig.price.text}</dd>
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
						<dd>{catalog.venues[gig.place]?.name ?? gig.place}</dd>
					</div>{/if}
				{#each extra as [k, v] (k)}<div>
						<dt>{capitalise(k.replaceAll('_', ' '))}</dt>
						<dd>{v}</dd>
					</div>{/each}
				{#if gig.artists.length}<div>
						<dt>Line-up read by</dt>
						<dd>{gig.lineup.source === 'fake' ? 'title rules' : gig.lineup.source}</dd>
					</div>{/if}
				<div>
					<dt>ID</dt>
					<dd><code>{gig.id}</code></dd>
				</div>
			</dl>
		</More>
	</div>
</main>

<style>
	.gig {
		max-width: 760px;
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
		font-size: clamp(36px, 6vw, 56px);
		overflow-wrap: break-word;
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
		border-radius: 10px;
		overflow: hidden;
	}
	.t-date {
		width: 64px;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		border-right: 1px dashed var(--line);
		padding: 10px 0;
	}
	.t-date b {
		font: 800 30px/0.9 var(--f-display);
		color: var(--amber);
	}
	.t-date span {
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--mute);
	}
	.t-body,
	.t-side {
		padding: 10px 14px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		min-width: 0;
	}
	.t-body {
		flex: 1;
	}
	.t-venue {
		font-weight: 650;
		font-size: 15px;
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t-venue:hover {
		text-decoration: underline;
	}
	.t-line,
	.t-side span {
		font-size: 12.5px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t-side {
		flex: none;
		align-items: flex-end;
		text-align: right;
		max-width: 40%;
	}
	.t-side b {
		font-size: 15px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px 10px;
		flex-wrap: wrap;
	}
	.t-side .note {
		color: var(--amber);
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.lineup ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.lineup li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
	}
	.lineup li:first-child {
		border-top: 1px solid var(--line);
	}
	.act {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.act a {
		font: 800 24px/1 var(--f-display);
		text-transform: uppercase;
		text-decoration: none;
		overflow-wrap: break-word;
	}
	.act a:hover {
		color: var(--amber);
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--mute);
		white-space: nowrap;
		overflow: hidden;
	}
	.meta > span:not(.badge) {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.role {
		font: 600 10px var(--f-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		flex: none;
	}
	.meta .badge {
		flex: none;
	}
	.image {
		max-width: min(100%, 480px);
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
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--f-mono);
		font-size: 12px;
	}

	@media (max-width: 700px) {
		.hero {
			gap: 14px;
		}
		.hero > :global(.poster) {
			--poster-size: 88px;
		}
		.actions > :global(.button) {
			flex: 1 1 0;
			min-width: max-content;
		}
		.details {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
		dd {
			margin-bottom: 8px;
		}
	}
</style>
