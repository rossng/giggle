<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import DensityStrip from '$lib/components/DensityStrip.svelte';
	import FilterPanel from '$lib/components/FilterPanel.svelte';
	import GigList from '$lib/components/GigList.svelte';
	import SiteNav from '$lib/components/SiteNav.svelte';
	import Wordmark from '$lib/components/Wordmark.svelte';
	import { amsterdamDate } from '$lib/data/dates';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';
	import {
		apply,
		dateWindow,
		facetCounts,
		isDefault,
		parse,
		toQuery,
		type Filters
	} from '$lib/data/filters';

	let { data } = $props();
	const catalog = $derived(data.catalog);

	// Read once per visit: the window is relative to today, and today changes at midnight.
	const now = new Date();
	const today = amsterdamDate(now);

	const filters = $derived(parse(page.url.searchParams));
	const query = $derived(toQuery(filters));
	const shown = $derived(apply(filters, catalog.gigs, now, unavailableDates.test));
	const counts = $derived(facetCounts(filters, catalog.gigs, now, unavailableDates.test));
	const range = $derived(dateWindow(filters, now));
	const venueCount = $derived(new Set(shown.map((v) => v.gig.venue)).size);
	const active = $derived(
		filters.cities.length +
			filters.venues.length +
			filters.genres.length +
			(filters.q ? 1 : 0) +
			filters.hide.length
	);

	/** Filter changes replace the history entry; links to other pages push one. */
	function update(next: Partial<Filters>) {
		const target = `${page.url.pathname}${toQuery({ ...filters, ...next })}`;
		if (target === `${page.url.pathname}${page.url.search}`) return;
		goto(target, { replaceState: true, keepFocus: true, noScroll: true });
	}

	let sheetOpen = $state(false);
</script>

<svelte:head>
	<title>{shown.length} gigs · giggle</title>
</svelte:head>

<svelte:window onkeydown={(e) => e.key === 'Escape' && sheetOpen && (sheetOpen = false)} />

<div class="agenda">
	<header class="topbar">
		<Wordmark />
		<button
			type="button"
			class="button"
			aria-expanded={sheetOpen}
			aria-controls="filters"
			onclick={() => (sheetOpen = !sheetOpen)}
		>
			Filters{#if active}<span class="count">{active}</span>{/if}
		</button>
	</header>

	<aside id="filters" class="side" class:open={sheetOpen} aria-label="Filters">
		<div class="brand">
			<Wordmark />
			<SiteNav {query} />
		</div>
		<FilterPanel {filters} {catalog} {counts} {range} onchange={update} />
		<p class="updated">Updated {catalog.generated.slice(0, 10)}</p>
	</aside>

	<main class="main">
		<div class="head">
			<div>
				<h1 class="display title">{shown.length} gig{shown.length === 1 ? '' : 's'}</h1>
				<p class="sub">
					{#if isDefault({ ...filters, order: null, seed: null })}at {venueCount} venues in the next 3
						months{:else}matching · {venueCount} venue{venueCount === 1 ? '' : 's'}{/if}
				</p>
			</div>
			<a class="button strong" href="/radio{query}">
				<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
					><path d="M3 1.8v8.4L10 6z" fill="currentColor" /></svg
				>
				Play these as radio
			</a>
		</div>

		<DensityStrip views={shown} {range} {today} />

		{#if shown.length}
			<GigList views={shown} {today} />
		{:else}
			<div class="empty">
				<p>No gigs match these filters.</p>
				<a class="button" href={page.url.pathname}>Clear all filters</a>
			</div>
		{/if}
	</main>
</div>

<style>
	.agenda {
		display: grid;
		grid-template-columns: 250px minmax(0, 1fr);
		min-height: 100vh;
	}
	.topbar {
		display: none;
	}
	.side {
		background: var(--p1);
		border-right: 1px solid var(--line);
		padding: 18px 16px 32px;
		display: flex;
		flex-direction: column;
		gap: 22px;
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.brand {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.brand :global(nav) {
		margin-left: -9px;
	}
	.updated {
		margin-top: auto;
		font: 500 10.5px var(--f-mono);
		color: var(--mute);
	}
	.main {
		padding: 18px 28px 80px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
		max-width: 1100px;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
	}
	.title {
		font-size: 44px;
	}
	.sub {
		font-size: 12px;
		color: var(--mute);
		margin-top: 4px;
	}
	.count {
		font: 600 10px/1 var(--f-mono);
		background: var(--amber);
		color: var(--bg);
		border-radius: 999px;
		padding: 3px 6px;
	}
	.empty {
		padding: 40px 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		color: var(--mute);
	}

	/* Phones and narrow windows: the sidebar becomes a sheet under a top bar. */
	@media (max-width: 860px) {
		.agenda {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto auto 1fr;
		}
		.topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 12px 16px;
			background: var(--p1);
			border-bottom: 1px solid var(--line);
			position: sticky;
			top: 0;
			z-index: 5;
		}
		.side {
			display: none;
			position: static;
			height: auto;
			border-right: 0;
			border-bottom: 1px solid var(--line);
		}
		.side.open {
			display: flex;
		}
		.brand :global(.wordmark) {
			display: none;
		}
		.main {
			padding: 14px 16px 60px;
		}
		.title {
			font-size: 34px;
		}
	}
</style>
