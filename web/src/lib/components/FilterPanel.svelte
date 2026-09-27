<!--
	The filter controls, shared by the agenda's Filters sheet and the radio's station drawer.
	With `primary` (the default) it starts with search and the time window; the agenda shows
	those on the page itself and passes `primary={false}`. Then: genre (buckets, each expandable
	into its specific styles), city, venue (collapsed), and what to hide.
-->
<script lang="ts">
	import SearchBox from '$lib/components/agenda/SearchBox.svelte';
	import WhenPicker from '$lib/components/agenda/WhenPicker.svelte';
	import UnavailableDates from '$lib/components/UnavailableDates.svelte';
	import type { Catalog } from '$lib/data/catalog';
	import { amsterdamDate, formatRange } from '$lib/data/dates';
	import {
		DEFAULT_FILTERS,
		bucketState,
		hasStyle,
		isDefault,
		toggle,
		toggleBucket,
		toggleStyle,
		type DateWindow,
		type FacetCounts,
		type Filters
	} from '$lib/data/filters';
	import { GENRES, GENRE_IDS, type GenreId } from '$lib/data/genres';
	import { upcomingRules } from '$lib/data/unavailable';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';

	let {
		filters,
		catalog,
		counts,
		range,
		onchange,
		primary = true
	}: {
		filters: Filters;
		catalog: Catalog;
		counts: FacetCounts;
		range: DateWindow;
		onchange: (next: Partial<Filters>) => void;
		/** Include search and the time window (and a "Clear all" at the end). */
		primary?: boolean;
	} = $props();

	// Two panels can be on the page at once (the agenda's sheet and the station drawer).
	const uid = $props.id();

	/** Styles shown before "more" in an opened bucket. */
	const FIRST_STYLES = 12;

	const buckets = $derived(
		GENRE_IDS.map((id) => {
			const styles = catalog.styles
				.filter((s) => s.buckets.includes(id))
				.map((s) => ({ ...s, n: counts.style.get(s.key) ?? 0, on: hasStyle(filters, s.slug) }))
				.filter((s) => s.n > 0 || s.on)
				.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
			return {
				...GENRES[id],
				n: counts.genre.get(id) ?? 0,
				state: bucketState(filters, id),
				styles,
				picked: styles.filter((s) => s.on).length
			};
		})
	);
	/** Buckets opened (or closed) by hand; otherwise a bucket is open when narrowed. */
	let opened = $state<Partial<Record<GenreId, boolean>>>({});
	let showAll = $state<Partial<Record<GenreId, boolean>>>({});

	const venues = $derived(
		catalog.venueList
			.map((v) => ({ ...v, n: counts.venue.get(v.slug) ?? 0 }))
			.filter((v) => v.n > 0 || filters.venues.includes(v.slug))
	);
	const venueSummary = $derived(
		filters.venues.length === 0
			? 'All'
			: filters.venues.length === 1
				? (catalog.venues[filters.venues[0]]?.name ?? filters.venues[0])
				: `${filters.venues.length} selected`
	);
	const cleared = $derived(isDefault({ ...filters, order: null, seed: null }));

	// The listener's unavailable dates are theirs, not the URL's: edited here, stored per user.
	const today = amsterdamDate(new Date());
	let editingDates = $state(false);
	const datesSet = $derived(upcomingRules(unavailableDates.items, today).length);

	function clearAll() {
		onchange({ ...DEFAULT_FILTERS, order: filters.order, seed: filters.seed });
	}
</script>

<div class="panel">
	{#if primary}
		<div class="block">
			<SearchBox value={filters.q} onchange={(q) => onchange({ q })} id="{uid}-search" />
		</div>
		<div class="block">
			<h3 class="label">When</h3>
			<WhenPicker days={filters.days} from={filters.from} {onchange} stretch />
			<p class="caption">{formatRange(range.first, range.last)}</p>
		</div>
	{/if}

	<section class="block" aria-labelledby="{uid}-genre">
		<h3 class="label" id="{uid}-genre">Genre</h3>
		<ul class="buckets">
			{#each buckets as b (b.id)}
				{@const open = opened[b.id] ?? b.state === 'some'}
				<li>
					<div class="bucket">
						<button
							type="button"
							class="pick"
							role="checkbox"
							aria-checked={b.state === 'all' ? 'true' : b.state === 'some' ? 'mixed' : 'false'}
							title={b.description}
							onclick={() => onchange(toggleBucket(filters, b.id))}
						>
							<span class="swatch {b.state}" style:--c={b.colour} aria-hidden="true"></span>
							<span class="name ellipsis">{b.label}</span>
							{#if b.picked}<span class="picked">{b.picked} style{b.picked === 1 ? '' : 's'}</span
								>{/if}
							<i>{b.n}</i>
						</button>
						{#if b.styles.length}
							<button
								type="button"
								class="open tap"
								aria-expanded={open}
								aria-controls="{uid}-styles-{b.id}"
								aria-label="{b.label} styles"
								title="{open ? 'Hide' : 'Pick'} {b.label} styles"
								onclick={() => (opened[b.id] = !open)}
							>
								<svg viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" /></svg>
							</button>
						{/if}
					</div>
					{#if open && b.styles.length}
						{@const all = showAll[b.id] || b.styles.length <= FIRST_STYLES + 2}
						<div class="styles" id="{uid}-styles-{b.id}" role="group" aria-label="{b.label} styles">
							{#each all ? b.styles : b.styles.slice(0, FIRST_STYLES) as s (s.key)}
								<button
									type="button"
									class="chip"
									aria-pressed={s.on}
									onclick={() => onchange({ styles: toggleStyle(filters.styles, s.slug) })}
									>{s.name}<i>{s.n}</i></button
								>
							{/each}
							{#if !all}
								<button type="button" class="chip more" onclick={() => (showAll[b.id] = true)}
									>{b.styles.length - FIRST_STYLES} more…</button
								>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<section class="block" aria-labelledby="{uid}-city">
		<h3 class="label" id="{uid}-city">City</h3>
		<div class="chips">
			{#each catalog.cities as c (c.key)}
				<button
					type="button"
					class="chip"
					aria-pressed={filters.cities.includes(c.key)}
					onclick={() => onchange({ cities: toggle(filters.cities, c.key) })}
				>
					{c.name}<i>{counts.city.get(c.key) ?? 0}</i>
				</button>
			{/each}
		</div>
	</section>

	<details class="venues" open={filters.venues.length > 0}>
		<summary>
			<span class="label">Venue</span>
			<span class="value ellipsis">{venueSummary}</span>
			<svg viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" /></svg>
		</summary>
		<ul>
			{#each venues as v (v.slug)}
				<li>
					<label>
						<input
							type="checkbox"
							checked={filters.venues.includes(v.slug)}
							onchange={() => onchange({ venues: toggle(filters.venues, v.slug) })}
						/>
						<span class="name ellipsis">{v.name}</span>
						<i>{v.n}</i>
					</label>
				</li>
			{/each}
		</ul>
	</details>

	<section class="block" aria-labelledby="{uid}-hide">
		<h3 class="label" id="{uid}-hide">Hide</h3>
		<button
			type="button"
			class="toggle"
			role="switch"
			aria-checked={filters.hide.includes('soldout')}
			onclick={() => onchange({ hide: toggle(filters.hide, 'soldout') })}
		>
			<span class="tg" aria-hidden="true"></span>Sold-out gigs
		</button>
		<button
			type="button"
			class="toggle"
			role="switch"
			aria-checked={filters.hide.includes('unavailable')}
			onclick={() => onchange({ hide: toggle(filters.hide, 'unavailable') })}
		>
			<span class="tg" aria-hidden="true"></span>Gigs on my unavailable dates
		</button>
		<button
			type="button"
			class="edit"
			aria-expanded={editingDates}
			aria-controls="{uid}-dates"
			onclick={() => (editingDates = !editingDates)}
		>
			{datesSet ? `${datesSet} date${datesSet === 1 ? '' : 's'} set` : 'None set'} · {editingDates
				? 'Done'
				: datesSet
					? 'Edit'
					: 'Add dates'}
		</button>
		{#if editingDates}<UnavailableDates {today} id="{uid}-dates" />{/if}
	</section>

	{#if primary && !cleared}
		<button type="button" class="button clear" onclick={clearAll}>Clear all filters</button>
	{/if}
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}
	h3 {
		margin: 0;
	}
	.caption {
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	i {
		font: 500 10.5px var(--f-mono);
		font-style: normal;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
	}

	/* Genre: one row per bucket, its styles below when opened. */
	.buckets {
		list-style: none;
		margin: 0 -8px;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.bucket {
		display: flex;
		align-items: center;
	}
	.pick {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
		padding: 0 8px;
		border: 0;
		border-radius: 8px;
		background: none;
		text-align: left;
		font-size: 13px;
		color: var(--mute);
		cursor: pointer;
	}
	.pick:hover {
		background: var(--p2);
		color: var(--ink);
	}
	.pick[aria-checked='true'],
	.pick[aria-checked='mixed'] {
		color: var(--ink);
		font-weight: 600;
	}
	.name {
		flex: 1;
		min-width: 0;
	}
	.picked {
		font: 500 10.5px var(--f-mono);
		color: var(--amber);
		white-space: nowrap;
	}
	/* A round swatch: outlined when off, half-filled when narrowed to styles, full when all. */
	.swatch {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		flex: none;
		border: 2px solid var(--c);
		opacity: 0.8;
	}
	.swatch.all {
		background: var(--c);
		opacity: 1;
	}
	.swatch.some {
		background: linear-gradient(90deg, var(--c) 50%, transparent 50%);
		opacity: 1;
	}
	.open {
		flex: none;
		width: 36px;
		height: 36px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--mute);
		display: grid;
		place-items: center;
		cursor: pointer;
		padding: 0;
	}
	.open:hover {
		background: var(--p2);
		color: var(--ink);
	}
	.open svg,
	summary svg {
		width: 10px;
		height: 6px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		transition: transform 0.15s;
	}
	.open[aria-expanded='true'] svg {
		transform: rotate(180deg);
	}
	.styles {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 4px 8px 10px 32px;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 30px;
		font-size: 12px;
		padding: 0 11px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: none;
		color: var(--mute);
		white-space: nowrap;
		cursor: pointer;
	}
	.chip:hover {
		color: var(--ink);
		border-color: var(--mute);
	}
	.chip[aria-pressed='true'] {
		background: var(--p3);
		border-color: var(--amber);
		color: var(--ink);
	}
	.chip.more {
		border-style: dashed;
	}

	/* Venue: collapsed to a line unless some are picked. */
	.venues summary {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
		cursor: pointer;
		list-style: none;
	}
	.venues summary::-webkit-details-marker {
		display: none;
	}
	.venues .value {
		flex: 1;
		min-width: 0;
		text-align: right;
		font-size: 12.5px;
		color: var(--ink);
	}
	.venues[open] summary svg {
		transform: rotate(180deg);
	}
	.venues summary svg {
		color: var(--mute);
	}
	.venues ul {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.venues label {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 32px;
		font-size: 13px;
		color: var(--mute);
		cursor: pointer;
	}
	.venues label:hover,
	.venues label:has(input:checked) {
		color: var(--ink);
	}
	.venues input {
		appearance: none;
		margin: 0;
		width: 16px;
		height: 16px;
		border-radius: 4px;
		border: 1.5px solid var(--line);
		flex: none;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.venues input:checked {
		background: var(--amber);
		border-color: var(--amber);
	}
	.venues input:checked::after {
		content: '';
		width: 7px;
		height: 4px;
		border: solid var(--bg);
		border-width: 0 0 1.5px 1.5px;
		transform: translateY(-1px) rotate(-45deg);
	}

	/* Hide: switches. */
	.toggle {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 32px;
		font-size: 13px;
		border: 0;
		background: none;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}
	.tg {
		width: 30px;
		height: 18px;
		border-radius: 999px;
		background: var(--p3);
		position: relative;
		flex: none;
	}
	.tg::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--mute);
		transition: left 0.15s;
	}
	.toggle[aria-checked='true'] .tg {
		background: var(--amber);
	}
	.toggle[aria-checked='true'] .tg::after {
		left: 15px;
		background: var(--bg);
	}
	.edit {
		align-self: flex-start;
		margin: -6px 0 0 40px;
		min-height: 28px;
		border: 0;
		background: none;
		padding: 0;
		font: 500 11px var(--f-mono);
		color: var(--mute);
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 3px;
	}
	.edit:hover {
		color: var(--ink);
	}
	.clear {
		align-self: flex-start;
	}

	@media (pointer: coarse) {
		.pick,
		.venues summary,
		.venues label,
		.toggle {
			min-height: 44px;
		}
		.chip {
			min-height: 40px;
			padding: 0 14px;
			font-size: 13px;
		}
		.chips,
		.styles {
			gap: 8px;
		}
		.edit {
			min-height: 40px;
			margin-top: -8px;
		}
		.clear {
			min-height: 44px;
		}
	}
</style>
