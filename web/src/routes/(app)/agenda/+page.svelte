<!--
	The agenda. Up front: how many gigs, a way to play them, search and the time window, and the
	list. Everything else (genre and style, city, venue, what to hide) is behind Filters, and
	whatever of that is active shows as removable chips above the list.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import DensityStrip from '$lib/components/DensityStrip.svelte';
	import GigList from '$lib/components/GigList.svelte';
	import ActiveChips from '$lib/components/agenda/ActiveChips.svelte';
	import FiltersSheet from '$lib/components/agenda/FiltersSheet.svelte';
	import ListenMoreEmpty from '$lib/components/ListenMoreEmpty.svelte';
	import SearchBox from '$lib/components/agenda/SearchBox.svelte';
	import WhenPicker from '$lib/components/agenda/WhenPicker.svelte';
	import { filterNames } from '$lib/data/catalog';
	import { amsterdamDate, formatRange } from '$lib/data/dates';
	import { personal } from '$lib/data/personal';
	import {
		activeFilters,
		apply,
		DEFAULT_FILTERS,
		dateWindow,
		facetCounts,
		parse,
		toQuery,
		type Filters
	} from '$lib/data/filters';
	import { radioApp } from '$lib/radio/app.svelte';
	import { stationFromParams } from '$lib/radio/station';

	let { data } = $props();
	const catalog = $derived(data.catalog);

	// Read once per visit: the window is relative to today, and today changes at midnight.
	const now = new Date();
	const today = amsterdamDate(now);

	const filters = $derived(parse(page.url.searchParams));
	const query = $derived(toQuery(filters));
	const shown = $derived(apply(filters, catalog.gigs, now, personal()));
	/** Every gig in the time window, for the density strip's totals. */
	const inWindow = $derived(
		apply({ ...DEFAULT_FILTERS, days: filters.days, from: filters.from }, catalog.gigs, now)
	);
	const counts = $derived(facetCounts(filters, catalog.gigs, now, personal()));
	const range = $derived(dateWindow(filters, now));
	const venueCount = $derived(new Set(shown.map((v) => v.gig.venue)).size);
	/** Where, for the heading: the picked cities, else the whole area. */
	const where = $derived.by(() => {
		const names = filters.cities.map(
			(key) => catalog.cities.find((c) => c.key === key)?.name ?? key
		);
		if (!names.length) return 'in and around Amsterdam';
		return `in ${names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0]}`;
	});
	const chips = $derived(activeFilters(filters, filterNames(catalog)));

	/** Filter changes replace the history entry; links to other pages push one. */
	function update(next: Partial<Filters>) {
		const target = `${page.url.pathname}${toQuery({ ...filters, ...next })}`;
		if (target === `${page.url.pathname}${page.url.search}`) return;
		goto(target, { replaceState: true, keepFocus: true, noScroll: true });
	}

	/** Clears the secondary filters, keeping search and the time window. */
	function clearFilters() {
		update({ cities: [], venues: [], genres: [], styles: [], hide: [], board: null });
	}

	function playAsRadio() {
		radioApp.playStation(catalog, stationFromParams(new URLSearchParams(query)));
	}

	let sheetOpen = $state(false);
</script>

<svelte:head>
	<title>{shown.length} gigs coming up {where} · giggle</title>
</svelte:head>

<div class="agenda">
	<header class="head">
		<div class="count">
			<h1 class="display">
				<span class="n">{shown.length} gig{shown.length === 1 ? '' : 's'}</span>
				<span class="where">coming up {where}</span>
			</h1>
			<p class="sub ellipsis">
				{venueCount} venue{venueCount === 1 ? '' : 's'} · {formatRange(range.first, range.last)}
			</p>
		</div>
		{#if shown.length}
			<a
				class="button strong radio"
				href="/radio{query}"
				onclick={playAsRadio}
				title="Play the artists of these gigs as a radio station"
			>
				<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
					><path d="M3 1.8v8.4L10 6z" fill="currentColor" /></svg
				>
				Play as radio
			</a>
		{/if}
	</header>

	<div class="bar">
		<div class="controls">
			<div class="search"><SearchBox value={filters.q} onchange={(q) => update({ q })} /></div>
			<div class="when">
				<WhenPicker days={filters.days} from={filters.from} onchange={update} />
			</div>
			<button
				type="button"
				class="filters tap"
				class:on={chips.length > 0}
				aria-haspopup="dialog"
				aria-controls="agenda-filters"
				aria-expanded={sheetOpen}
				onclick={() => (sheetOpen = true)}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M4.5 8h7M7 12h2" /></svg>
				Filters{#if chips.length}<span class="badge-count">{chips.length}</span>{/if}
			</button>
		</div>

		{#if chips.length}
			<ActiveChips {chips} onchange={update} onclear={clearFilters} />
		{/if}
	</div>

	{#if shown.length}
		<div class="density"><DensityStrip views={shown} all={inWindow} {range} /></div>
		<GigList views={shown} {today} />
		<p class="updated">Listings updated {catalog.generated.slice(0, 10)}</p>
	{:else}
		<div class="empty">
			{#if filters.board}
				<ListenMoreEmpty {filters} {catalog} gigs={0} context="agenda" onchange={update} />
			{:else}
				<p>No gigs match.</p>
				<a class="button" href={page.url.pathname}>Show all gigs</a>
			{/if}
		</div>
	{/if}
</div>

<FiltersSheet
	bind:open={sheetOpen}
	{filters}
	{catalog}
	{counts}
	{range}
	shown={shown.length}
	active={chips.length}
	onchange={update}
	onclear={clearFilters}
/>

<style>
	.agenda {
		max-width: 1080px;
		margin: 0 auto;
		padding: 20px 28px 40px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
	}
	.count {
		min-width: 0;
	}
	h1 {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 12px;
		font-size: 44px;
		line-height: 1;
	}
	h1 span {
		white-space: nowrap;
	}
	.where {
		font-size: 26px;
		color: var(--mute);
	}
	.sub {
		font-size: 12.5px;
		color: var(--mute);
		margin-top: 4px;
	}
	.radio {
		flex: none;
		height: 36px;
		padding: 0 16px;
	}

	/* Search, the window and Filters on one line, and the active filters, kept in view while the
	   list scrolls. */
	.bar {
		position: sticky;
		top: var(--top-h);
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 0 -28px;
		padding: 8px 28px;
		background: var(--bg);
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.search {
		flex: 1;
		min-width: 160px;
	}
	.when {
		flex: none;
	}
	.filters {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 36px;
		padding: 0 14px 0 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--p1);
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}
	.filters:hover {
		border-color: var(--mute);
	}
	.filters.on {
		border-color: var(--amber);
	}
	.filters svg {
		width: 15px;
		height: 15px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
	}
	.badge-count {
		font: 600 10.5px/1 var(--f-mono);
		background: var(--amber);
		color: var(--bg);
		border-radius: 999px;
		min-width: 18px;
		padding: 4px 5px;
		text-align: center;
	}
	.density {
		margin-top: 2px;
	}
	.updated {
		margin-top: 18px;
		font: 500 10.5px var(--f-mono);
		color: var(--mute);
	}
	.empty {
		padding: 40px 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		color: var(--mute);
	}

	/* Mid widths: the window goes under search and Filters. */
	@media (max-width: 900px) {
		.controls {
			flex-wrap: wrap;
		}
		.search {
			flex-basis: 0;
		}
		.when {
			order: 3;
			flex: 1 1 100%;
		}
	}

	/* Phones: tighter, and the controls scroll away with the page (the list needs the room). */
	@media (max-width: 700px) {
		.agenda {
			padding: 14px 16px 24px;
			gap: 12px;
		}
		h1 {
			font-size: 34px;
			flex-direction: column;
			align-items: flex-start;
			row-gap: 2px;
		}
		.where {
			font-size: 19px;
			white-space: normal;
		}
		.sub {
			font-size: 12px;
		}
		.bar {
			position: static;
			margin: 0;
			padding: 0;
			gap: 12px;
		}
		.search {
			min-width: 0;
		}
		.when :global(.seg) {
			flex: 1;
		}
		.density {
			display: none;
		}
	}
</style>
