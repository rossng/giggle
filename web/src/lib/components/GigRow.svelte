<script lang="ts">
	import type { GigView } from '$lib/data/catalog';
	import { dayParts } from '$lib/data/dates';
	import { GENRES } from '$lib/data/genres';
	import PosterTile from './PosterTile.svelte';

	let { view, showVenue = true }: { view: GigView; showVenue?: boolean } = $props();

	const day = $derived(dayParts(view.date));
	const gig = $derived(view.gig);
	const place = $derived(
		[gig.room, view.cityName && view.city !== 'amsterdam' ? view.cityName : null]
			.filter(Boolean)
			.join(' · ')
	);
	const tagline = $derived(
		view.details.length ? view.details : view.buckets.map((b) => GENRES[b].label.toLowerCase())
	);
	const note = $derived(
		gig.status === 'postponed' ? 'Postponed' : gig.status === 'moved' ? 'Moved' : null
	);
</script>

<article class="gig" class:sold={view.soldOut}>
	<div class="date">
		<span>{day.weekday}</span><b>{day.day}</b><span>{day.month}</span>
	</div>
	<PosterTile name={view.headliner} colour={view.colour} thumb={view.thumb} />
	<div class="main">
		<h3><a href={view.href}>{gig.title}</a></h3>
		{#if view.support.length}
			<p class="sub">+ {view.support.join(', ')}</p>
		{:else if gig.subtitle}
			<p class="sub">{gig.subtitle}</p>
		{/if}
		{#if tagline.length || note}
			<p class="tagline">
				{#if note}<span class="note">{note}</span>{/if}
				{#if view.primary}<span class="dot" style:background={view.colour}></span>{/if}
				<span class="text">{tagline.join(' · ')}</span>
			</p>
		{/if}
	</div>
	{#if showVenue}
		<div class="venue">
			<b>{view.venueName}</b>
			{#if place}<span>{place}</span>{/if}
		</div>
	{/if}
	<div class="when">
		<b>{view.time}</b>
		{#if view.soldOut}
			<span class="soldout">Sold out</span>
		{:else if view.price}
			<span>{view.price}</span>
		{/if}
	</div>
	<button
		class="play"
		type="button"
		disabled
		title="Radio coming soon"
		aria-label="Play {view.headliner} (radio coming soon)"
	>
		<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" /></svg>
	</button>
</article>

<style>
	.gig {
		position: relative;
		display: grid;
		grid-template-columns: 40px 52px minmax(0, 1fr) minmax(120px, 170px) 64px 30px;
		grid-template-areas: 'date poster main venue when play';
		gap: 14px;
		align-items: center;
		padding: 6px 8px;
		margin: 0 -8px;
		border-radius: 8px;
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
	}
	h3 a {
		text-decoration: none;
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
	.tagline {
		font-size: 12px;
		color: var(--mute);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tagline {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11.5px;
	}
	.tagline .text {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.note {
		font: 600 9.5px/1 var(--f-mono);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--amber);
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 2px 4px;
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
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.venue span,
	.when span {
		font-size: 11.5px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		grid-area: when;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.when .soldout {
		color: var(--bad);
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
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: 1px solid var(--line);
		background: none;
		display: grid;
		place-items: center;
		color: var(--mute);
		cursor: not-allowed;
		padding: 0;
	}
	.play svg {
		width: 11px;
		height: 11px;
		fill: currentColor;
		margin-left: 2px;
	}

	@media (max-width: 720px) {
		.gig {
			grid-template-columns: 34px 52px minmax(0, 1fr) auto;
			grid-template-areas:
				'date poster main main'
				'date poster venue when';
			column-gap: 10px;
			row-gap: 2px;
			align-items: start;
		}
		.play {
			display: none;
		}
		.venue {
			flex-direction: row;
			gap: 6px;
			align-items: baseline;
		}
		.when {
			flex-direction: row-reverse;
			gap: 6px;
			align-items: baseline;
		}
		.when b {
			font-weight: 500;
			color: var(--mute);
			font-size: 11.5px;
		}
		.venue b {
			font-size: 12px;
		}
	}
</style>
