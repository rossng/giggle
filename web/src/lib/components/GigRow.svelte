<!--
	One gig in a list: date, poster, title (and support, and your plan for it), venue, time and
	price, and ▶ to hear the headliner on the radio. A quieter line under the title gives a style
	or two and where the headliner is from (wide screens only). The whole row links to the gig.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { TRIAGE_LABELS } from '$lib/board/board';
	import { boardStore } from '$lib/board/board-store.svelte';
	import type { Catalog, GigView } from '$lib/data/catalog';
	import { dayParts } from '$lib/data/dates';
	import { GENRES } from '$lib/data/genres';
	import { radioApp } from '$lib/radio/app.svelte';
	import PosterTile from './PosterTile.svelte';

	let { view, showVenue = true }: { view: GigView; showVenue?: boolean } = $props();

	const day = $derived(dayParts(view.date));
	// ▶ plays the first act with songs on the radio (the app-wide player keeps going).
	const catalog = $derived(page.data.catalog as Catalog | undefined);
	const playable = $derived(
		view.gig.artists.find((a) => catalog?.artists[a.key]?.youtube?.songs?.length)
	);
	function play() {
		if (catalog && playable) radioApp.playArtist(catalog, playable.key, playable.name);
	}
	const gig = $derived(view.gig);
	const plan = $derived(boardStore.gigState(view.id));
	const place = $derived(
		[gig.room, view.cityName && view.city !== 'amsterdam' ? view.cityName : null]
			.filter(Boolean)
			.join(' · ')
	);
	const tagline = $derived(
		view.details.length
			? view.details
			: view.buckets.slice(0, 2).map((b) => GENRES[b].label.toLowerCase())
	);
	const note = $derived(
		gig.status === 'postponed' ? 'Postponed' : gig.status === 'moved' ? 'Moved' : null
	);
</script>

<article class="gig" class:sold={view.soldOut} class:novenue={!showVenue}>
	<div class="date">
		<span>{day.weekday}</span><b>{day.day}</b><span>{day.month}</span>
	</div>
	<PosterTile name={view.headliner} colour={view.colour} thumb={view.thumb} />
	<div class="main">
		<h3>
			<a href={view.href}>{gig.title}</a>{#if plan}
				<span class="badge b-{plan}">{TRIAGE_LABELS[plan]}</span>{/if}
		</h3>
		{#if view.support.length}
			<p class="sub ellipsis">+ {view.support.join(', ')}</p>
		{:else if gig.subtitle}
			<p class="sub ellipsis">{gig.subtitle}</p>
		{/if}
		{#if tagline.length || note}
			<p class="tagline ellipsis">
				{#if note}<span class="note">{note}</span>{/if}
				<span class="text">{tagline.join(' · ')}</span>
			</p>
		{/if}
		<!-- Phones: venue, time and price in one line under the title. -->
		<p class="meta ellipsis">
			{#if note}<span class="note">{note}</span>{/if}
			{#if showVenue}<span class="where">{view.venueName}</span>{/if}
			<span class="time">{view.time}</span>
			{#if view.soldOut}
				<span class="soldout">Sold out</span>
			{:else if view.price}
				<span class="price">{view.price}</span>
			{/if}
		</p>
	</div>
	{#if showVenue}
		<div class="venue">
			<b class="ellipsis">{view.venueName}</b>
			{#if place}<span class="ellipsis">{place}</span>{/if}
		</div>
	{/if}
	<div class="when">
		<b class="ellipsis">{view.time}</b>
		{#if view.soldOut}
			<span class="soldout ellipsis">Sold out</span>
		{:else if view.price}
			<span class="ellipsis">{view.price}</span>
		{/if}
	</div>
	<button
		class="play tap"
		type="button"
		disabled={!playable}
		title={playable ? `Play ${playable.name}` : 'No songs to play'}
		aria-label={playable ? `Play ${playable.name}` : `No songs for ${view.headliner}`}
		onclick={play}
	>
		<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" /></svg>
	</button>
</article>

<style>
	.gig {
		position: relative;
		display: grid;
		grid-template-columns: 38px 52px minmax(0, 1fr) minmax(120px, 180px) 72px 36px;
		grid-template-areas: 'date poster main venue when play';
		column-gap: 14px;
		align-items: center;
		padding: 7px 8px;
		margin: 0 -8px;
		border-radius: 8px;
	}
	.gig.novenue {
		grid-template-columns: 38px 52px minmax(0, 1fr) 72px 36px;
		grid-template-areas: 'date poster main when play';
	}
	.gig:hover,
	.gig:focus-within {
		background: var(--p1);
	}
	.date {
		grid-area: date;
		display: flex;
		flex-direction: column;
		align-items: center;
		line-height: 1;
	}
	.date span {
		font: 600 9.5px var(--f-mono);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--mute);
	}
	.date b {
		font: 800 26px/1 var(--f-display);
	}
	.gig > :global(.poster) {
		grid-area: poster;
	}
	.main {
		grid-area: main;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	h3 {
		font-size: 15px;
		font-weight: 650;
		line-height: 1.25;
		text-wrap: pretty;
		/* At most two lines, then an ellipsis. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	h3 a {
		text-decoration: none;
	}
	h3 .badge {
		vertical-align: 2px;
	}
	h3 a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	/* The whole row is the link's hit area; the play button sits above it. */
	h3 a::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 8px;
	}
	h3 a:focus-visible {
		outline: none;
	}
	h3 a:focus-visible::after {
		outline: 2px solid var(--amber);
		outline-offset: 0;
	}
	.sub,
	.tagline,
	.meta {
		font-size: 12px;
		color: var(--mute);
	}
	.tagline {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		opacity: 0.8;
	}
	.tagline .text {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.note {
		flex: none;
		font: 600 9px/1 var(--f-mono);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--amber);
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 2px 4px;
	}
	.meta {
		display: none;
	}
	.venue,
	.when {
		display: flex;
		flex-direction: column;
		font-size: 13px;
		min-width: 0;
	}
	.venue {
		grid-area: venue;
	}
	.venue b,
	.when b {
		font-weight: 600;
	}
	.venue span,
	.when span {
		font-size: 11.5px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
	}
	.when {
		grid-area: when;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.soldout {
		color: var(--bad) !important;
		font-weight: 600;
	}
	.sold .date b,
	.sold h3 {
		opacity: 0.75;
	}
	.play {
		grid-area: play;
		position: relative;
		z-index: 1;
		justify-self: end;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		border: 1px solid var(--line);
		background: none;
		display: grid;
		place-items: center;
		color: var(--ink);
		cursor: pointer;
		padding: 0;
	}
	.play:enabled:hover {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--bg);
	}
	.play:disabled {
		color: var(--mute);
		opacity: 0.35;
		cursor: not-allowed;
	}
	.play svg {
		width: 11px;
		height: 11px;
		fill: currentColor;
		margin-left: 2px;
	}

	/* Phones: date, poster, then title / support / "venue · time · price", and ▶. */
	@media (max-width: 700px) {
		.gig,
		.gig.novenue {
			--poster-size: 48px;
			grid-template-columns: 30px 48px minmax(0, 1fr) 44px;
			grid-template-areas: 'date poster main play';
			column-gap: 10px;
			padding: 8px 6px;
			margin: 0 -6px;
		}
		.date b {
			font-size: 22px;
		}
		.date span {
			font-size: 9px;
		}
		h3 {
			font-size: 14.5px;
		}
		.sub {
			font-size: 11.5px;
		}
		.tagline,
		.venue,
		.when {
			display: none;
		}
		.meta {
			display: flex;
			align-items: center;
			gap: 0;
			font-size: 12px;
		}
		.meta > span + span::before {
			content: '·';
			margin: 0 5px;
			color: var(--mute);
		}
		.meta .note {
			margin-right: 6px;
		}
		.meta .note + span::before {
			content: none;
		}
		.where {
			color: var(--ink);
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.time,
		.price,
		.meta .soldout {
			flex: none;
			font-variant-numeric: tabular-nums;
		}
	}
	@media (pointer: coarse) {
		.play {
			width: 44px;
			height: 44px;
		}
		.gig {
			grid-template-columns: 38px 52px minmax(0, 1fr) minmax(120px, 180px) 72px 44px;
		}
		.gig.novenue {
			grid-template-columns: 38px 52px minmax(0, 1fr) 72px 44px;
		}
	}
	@media (pointer: coarse) and (max-width: 700px) {
		.gig,
		.gig.novenue {
			grid-template-columns: 30px 48px minmax(0, 1fr) 44px;
		}
	}
</style>
