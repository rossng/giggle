<script lang="ts">
	import { untrack } from 'svelte';
	import UnavailableDates from '$lib/components/UnavailableDates.svelte';
	import type { Catalog } from '$lib/data/catalog';
	import { amsterdamDate, formatRange } from '$lib/data/dates';
	import {
		DAY_PRESETS,
		DEFAULT_FILTERS,
		FROM_PRESETS,
		cleanQuery,
		isDefault,
		toggle,
		type DateWindow,
		type FacetCounts,
		type Filters
	} from '$lib/data/filters';
	import { GENRES, GENRE_IDS } from '$lib/data/genres';
	import { upcomingRules } from '$lib/data/unavailable';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';

	let {
		filters,
		catalog,
		counts,
		range,
		onchange
	}: {
		filters: Filters;
		catalog: Catalog;
		counts: FacetCounts;
		range: DateWindow;
		onchange: (next: Partial<Filters>) => void;
	} = $props();

	// Search updates the URL after a pause in typing, not on every key.
	let query = $state(untrack(() => filters.q));
	let timer: ReturnType<typeof setTimeout> | undefined;
	function search(value: string) {
		query = value;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			onchange({ q: cleanQuery(value) });
		}, 250);
	}
	// Follow the URL when it changes from elsewhere (e.g. "Clear all").
	$effect(() => {
		const q = filters.q;
		untrack(() => {
			if (timer === undefined && cleanQuery(query) !== q) query = q;
		});
	});

	const genres = $derived(GENRE_IDS.map((id) => ({ ...GENRES[id], n: counts.genre.get(id) ?? 0 })));
	const venues = $derived(
		catalog.venueList
			.map((v) => ({ ...v, n: counts.venue.get(v.slug) ?? 0 }))
			.filter((v) => v.n > 0 || filters.venues.includes(v.slug))
	);
	const cleared = $derived(isDefault({ ...filters, order: null, seed: null }) && query === '');
	const soldOutHidden = $derived(filters.hide.includes('soldout'));

	// The listener's unavailable dates are theirs, not the URL's: edited here, stored per user.
	const today = amsterdamDate(new Date());
	let editingDates = $state(false);
	const datesSet = $derived(upcomingRules(unavailableDates.items, today).length);

	function clearAll() {
		clearTimeout(timer);
		timer = undefined;
		query = '';
		onchange({ ...DEFAULT_FILTERS, order: filters.order, seed: filters.seed });
	}
</script>

<div class="panel">
	<div class="block">
		<label class="label" for="search">Search</label>
		<input
			id="search"
			type="search"
			placeholder="Artist, venue, title…"
			autocomplete="off"
			spellcheck="false"
			value={query}
			oninput={(e) => search(e.currentTarget.value)}
		/>
	</div>

	<fieldset class="block">
		<legend class="label">When</legend>
		<div class="seg" role="group" aria-label="Window length">
			{#each DAY_PRESETS as p (p.days)}
				<button
					type="button"
					aria-pressed={filters.days === p.days}
					onclick={() => onchange({ days: p.days })}>{p.label}</button
				>
			{/each}
		</div>
		<span class="label sub" id="starting">Starting</span>
		<div class="seg" role="group" aria-labelledby="starting">
			{#each FROM_PRESETS as p (p.from)}
				<button
					type="button"
					aria-pressed={filters.from === p.from}
					onclick={() => onchange({ from: p.from })}>{p.label}</button
				>
			{/each}
		</div>
		<p class="caption">{formatRange(range.first, range.last)}</p>
	</fieldset>

	<div class="block toggles">
		<button
			type="button"
			class="toggle"
			role="switch"
			aria-checked={soldOutHidden}
			onclick={() => onchange({ hide: toggle(filters.hide, 'soldout') })}
		>
			<span class="tg" aria-hidden="true"></span>Hide sold out
		</button>
		<button
			type="button"
			class="toggle"
			role="switch"
			aria-checked={filters.hide.includes('unavailable')}
			onclick={() => onchange({ hide: toggle(filters.hide, 'unavailable') })}
		>
			<span class="tg" aria-hidden="true"></span>Hide my unavailable dates
		</button>
		<button
			type="button"
			class="caption edit"
			aria-expanded={editingDates}
			aria-controls="unavailable-dates"
			onclick={() => (editingDates = !editingDates)}
		>
			{datesSet ? `${datesSet} set` : 'None set'} · {editingDates
				? 'Done'
				: datesSet
					? 'Edit'
					: 'Add dates'}
		</button>
		{#if editingDates}<UnavailableDates {today} id="unavailable-dates" />{/if}
	</div>

	<fieldset class="block">
		<legend class="label">Genre</legend>
		<div class="chips">
			{#each genres as g (g.id)}
				<button
					type="button"
					class="chip"
					aria-pressed={filters.genres.includes(g.id)}
					title={g.description}
					onclick={() => onchange({ genres: toggle(filters.genres, g.id) })}
				>
					<span class="dot" style:background={g.colour}></span>{g.label}<i>{g.n}</i>
				</button>
			{/each}
		</div>
	</fieldset>

	<fieldset class="block">
		<legend class="label">City</legend>
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
	</fieldset>

	<fieldset class="block">
		<legend class="label">Venue</legend>
		<ul class="venues">
			{#each venues as v (v.slug)}
				<li>
					<label>
						<input
							type="checkbox"
							checked={filters.venues.includes(v.slug)}
							onchange={() => onchange({ venues: toggle(filters.venues, v.slug) })}
						/>
						<span class="name">{v.name}</span>
						<i>{v.n}</i>
					</label>
				</li>
			{/each}
		</ul>
	</fieldset>

	{#if !cleared}
		<button type="button" class="button clear" onclick={clearAll}>Clear all filters</button>
	{/if}
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	legend {
		padding: 0;
		margin-bottom: 8px;
	}
	.sub {
		margin-top: 4px;
	}
	.caption {
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	input[type='search'] {
		width: 100%;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 7px 10px;
		font-size: 13px;
	}
	input[type='search']::placeholder {
		color: var(--mute);
	}

	.seg {
		display: flex;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 2px;
		gap: 2px;
	}
	.seg button {
		flex: 1;
		border: 0;
		background: none;
		padding: 5px 4px;
		border-radius: 6px;
		font-size: 11.5px;
		color: var(--mute);
		white-space: nowrap;
		cursor: pointer;
	}
	.seg button:hover {
		color: var(--ink);
	}
	.seg button[aria-pressed='true'] {
		background: var(--p3);
		color: var(--ink);
		font-weight: 600;
	}

	.toggles {
		gap: 10px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 12.5px;
		border: 0;
		background: none;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}
	.tg {
		width: 28px;
		height: 16px;
		border-radius: 999px;
		background: var(--p3);
		position: relative;
		flex: none;
	}
	.tg::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
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
		left: 14px;
		background: var(--bg);
	}
	.edit {
		align-self: flex-start;
		margin: -4px 0 0 37px;
		border: 0;
		background: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 3px;
	}
	.edit:hover {
		color: var(--ink);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		padding: 4px 8px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: none;
		color: var(--mute);
		cursor: pointer;
	}
	.chip:hover {
		color: var(--ink);
	}
	.chip[aria-pressed='true'] {
		background: var(--p3);
		border-color: var(--p3);
		color: var(--ink);
	}
	i {
		font: 500 10px var(--f-mono);
		font-style: normal;
		color: var(--mute);
	}

	.venues {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.venues label {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--mute);
		padding: 2px 0;
		cursor: pointer;
	}
	.venues label:hover,
	.venues label:has(input:checked) {
		color: var(--ink);
	}
	.venues input {
		appearance: none;
		margin: 0;
		width: 13px;
		height: 13px;
		border-radius: 3px;
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
		width: 6px;
		height: 3px;
		border: solid var(--bg);
		border-width: 0 0 1.5px 1.5px;
		transform: translateY(-1px) rotate(-45deg);
	}
	.venues .name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.venues i {
		font-size: 10.5px;
	}
	.clear {
		align-self: flex-start;
	}
</style>
