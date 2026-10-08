<script lang="ts">
	// The Board: what you've sorted, in columns. Gigs (want to go, got tickets, been) and artists
	// (listen more, not for me): the columns are the page. Each card has a ⋯ button to move it
	// within its kind; with a mouse, cards also drag, and a focused card takes 1/2/3/X like the
	// radio. On phones one column shows at a time, picked from the row of column tabs. Listen more
	// plays as a radio station of just those artists.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import TriageButtons from '$lib/components/TriageButtons.svelte';
	import {
		ARTIST_TRIAGES,
		gigIdOf,
		GIG_TRIAGES,
		isArtistTriage,
		isGigTriage,
		TRIAGE_KEYS,
		TRIAGE_LABELS,
		type Triage
	} from '$lib/board/board';
	import { boardStore } from '$lib/board/board-store.svelte';
	import {
		boardColumns,
		COLUMNS,
		countdownText,
		type Card,
		type ColumnId
	} from '$lib/board/columns';
	import { amsterdamDate, dayParts, localDate, localTime } from '$lib/data/dates';
	import { allOfBoard, toQuery } from '$lib/data/filters';
	import { own } from '$lib/data/own';
	import { personal } from '$lib/data/personal';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';
	import { artistPath } from '$lib/data/slugs';
	import type { SyncStatus } from '$lib/sync/client';
	import { sync as syncClient } from '$lib/sync/app';
	import { radioApp } from '$lib/radio/app.svelte';
	import { stationFromParams } from '$lib/radio/station';

	let { data } = $props();
	const catalog = $derived(data.catalog);

	const board = $derived(boardStore.items);
	const today = amsterdamDate(new Date());
	const columns = $derived(boardColumns(board, catalog, today, unavailableDates.test));
	const cards = $derived(Object.values(columns).flat());
	const total = $derived(cards.length);
	const gigCount = $derived(cards.filter((c) => c.kind === 'gig').length);
	// /board?column=go shows one column (the URL shape agreed for deep links).
	const only = $derived(
		COLUMNS.find((c) => c.id === page.url.searchParams.get('column'))?.id ?? null
	);
	const shown = $derived(COLUMNS.filter((c) => !only || c.id === only));
	/** On phones, the one column showing: the URL's, else the first of yours with anyone in it. */
	const current = $derived<ColumnId>(
		only ?? (['go', 'tickets', 'listen'] as const).find((id) => columns[id].length) ?? 'listen'
	);

	/** The listen-more station: all their upcoming gigs (null: none has one). */
	const listenQuery = $derived.by(() => {
		const filters = allOfBoard('listen', catalog.gigs, new Date(), personal());
		return filters && toQuery(filters);
	});

	function playListenMore(query: string) {
		radioApp.playStation(catalog, stationFromParams(new URLSearchParams(query)));
	}

	let focused: string | null = $state(null);
	/** The card whose move buttons are open. */
	let moving: string | null = $state(null);
	let sync: SyncStatus | null = $state(null);
	const SYNC_TEXT: Record<SyncStatus['state'], string> = {
		synced: 'Synced',
		syncing: 'Syncing…',
		offline: 'Offline: saved on this device',
		'signed-out': 'On this device only',
		error: 'Sync problem'
	};
	let dragging: Card | null = $state(null);

	onMount(() => syncClient?.subscribe((s) => (sync = s)));

	/** The states a card can move to: its own kind's. */
	function statesOf(card: Card): readonly Triage[] {
		return card.kind === 'gig' ? GIG_TRIAGES : ARTIST_TRIAGES;
	}

	/** Re-sorts a card within its kind, or takes it off the board (null). */
	function move(card: Card, state: Triage | null) {
		moving = null;
		if (card.kind === 'artist') {
			if (state === null || isArtistTriage(state)) {
				boardStore.setArtist({ key: card.key, name: card.item.name }, state);
			}
		} else if (state === null || isGigTriage(state)) {
			const when = card.start ?? card.item.when;
			boardStore.setGig(gigIdOf(card.key), state, {
				artist: { key: card.artistKey, name: card.item.name },
				...(when ? { when } : {})
			});
		}
	}

	/** Takes `card` (the one being dragged): its own kind's columns, but not Been, which follows
	 * the gig date. */
	function takes(column: ColumnId, card: Card | null): boolean {
		return !!card && column !== 'been' && statesOf(card).includes(column as Triage);
	}

	function drop(column: ColumnId) {
		const card = dragging;
		dragging = null;
		if (card && takes(column, card) && card.state !== column) move(card, column as Triage);
	}

	function onKey(e: KeyboardEvent, card: Card) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const key = e.key.toLowerCase();
		const state = statesOf(card).find((t) => TRIAGE_KEYS[t].toLowerCase() === key);
		if (state) {
			e.preventDefault();
			move(card, state);
		} else if (key === 'delete' || key === 'backspace') {
			e.preventDefault();
			move(card, null);
		} else if (key === 'escape' && moving === card.key) {
			moving = null;
		}
	}

	/** When and where: a gig card's gig (as stored once it's left the data), an artist's next. */
	function gigLine(card: Card): string | null {
		if (!card.start) return null;
		const v = card.gig;
		const d = dayParts(localDate(card.start));
		const place = v && v.city !== 'amsterdam' ? `${v.venueName}, ${v.cityName}` : card.venueName;
		const line = [`${d.weekday} ${d.day} ${d.month}`, localTime(card.start), place]
			.filter(Boolean)
			.join(' · ');
		return card.kind === 'artist' ? `Next: ${line}` : line;
	}

	function artistHref(key: string | null): string | undefined {
		const artist = key ? own(catalog.artists, key) : undefined;
		return artist ? artistPath(artist) : undefined;
	}

	const WARNINGS = {
		'sold-out': { text: 'Sold out', title: 'Sold out: check resale', mute: false },
		unlisted: {
			text: 'No longer listed',
			title: "Gone from the venue's listings: cancelled or moved?",
			mute: false
		},
		'no-gig': { text: 'No gig listed', title: 'No upcoming gig in the data', mute: true },
		unavailable: { text: "You're away", title: 'On one of your unavailable dates', mute: false }
	} as const;
</script>

<svelte:head><title>Board · giggle</title></svelte:head>

<main class="page board">
	<header class="head">
		<h1 class="display page-title">Board</h1>
		<p class="sub">
			{#if total}
				<span
					>{gigCount} gig{gigCount === 1 ? '' : 's'} · {total - gigCount} artist{total -
						gigCount ===
					1
						? ''
						: 's'}</span
				>
			{/if}
			{#if sync}
				<span class="sync {sync.state}" title={sync.error ?? sync.user ?? ''}
					>{SYNC_TEXT[sync.state]}</span
				>
				{#if sync.state === 'signed-out'}<a href="/account">Sign in to sync</a>{/if}
			{/if}
			{#if only}<a class="all" href="/board">All columns</a>{/if}
		</p>
	</header>

	{#if total === 0}
		<div class="empty">
			<p>
				Nothing sorted yet. On the <a href="/radio">radio</a>, sort who's playing: listen more or
				not for me is about the artist<span class="kbd-hint"> (<kbd>1</kbd> <kbd>X</kbd>)</span>;
				want to go or got tickets is about their gig<span class="kbd-hint">
					(<kbd>2</kbd> <kbd>3</kbd>)</span
				>, as on every gig's page. They land here.
			</p>
			<a class="button strong" href="/radio">Open the radio</a>
		</div>
	{/if}

	<nav class="tabs" aria-label="Columns">
		{#each COLUMNS as column (column.id)}
			<a
				href="/board?column={column.id}"
				data-sveltekit-replacestate
				data-sveltekit-noscroll
				aria-current={current === column.id ? 'true' : undefined}
			>
				<span class="t-top"
					><i class="mark {column.id}" aria-hidden="true"></i><b>{columns[column.id].length}</b
					></span
				>
				<span class="t-label ellipsis">{column.label}</span>
			</a>
		{/each}
	</nav>

	<div class="cols" class:single={!!only}>
		{#if !only}
			<p class="group gigs">Gigs <span>your plans</span></p>
			<p class="group artists">Artists <span>for the radio</span></p>
		{/if}
		{#each shown as column (column.id)}
			<section
				class="col"
				class:current={current === column.id}
				class:faded={column.id === 'been' || column.id === 'nope'}
				aria-labelledby="col-{column.id}"
				class:closed={!!dragging && !takes(column.id, dragging)}
				ondragover={(e) => {
					if (takes(column.id, dragging)) e.preventDefault();
				}}
				ondrop={() => drop(column.id)}
			>
				<header title={column.hint}>
					<i class="mark {column.id}" aria-hidden="true"></i>
					<h2 id="col-{column.id}" class="ellipsis">{column.label}</h2>
					<span class="n">{columns[column.id].length}</span>
				</header>
				{#if !columns[column.id].length}
					<p class="hint">{column.hint}.</p>
				{:else if column.id === 'listen'}
					{#if listenQuery}
						<a
							class="button play"
							href="/radio{listenQuery}"
							title="A radio station of just your listen-more artists"
							onclick={() => playListenMore(listenQuery)}
						>
							<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
								><path d="M3 1.8v8.4L10 6z" fill="currentColor" /></svg
							>
							Play them on the radio
						</a>
					{:else}
						<p class="hint">None of them has a gig coming up, so there's nothing to play yet.</p>
					{/if}
				{/if}
				{#each columns[column.id] as card (card.key)}
					{@const line = gigLine(card)}
					{@const when = countdownText(card.inDays)}
					{@const href = artistHref(card.artistKey)}
					<!-- Cards are focusable so 1/2/3/X re-sort them from the keyboard, as on the radio;
					     the same moves are behind the card's ⋯ button. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
					<article
						class="card"
						class:focused={focused === card.key}
						style:--strip={card.gig?.colour ?? 'var(--p3)'}
						draggable="true"
						tabindex="0"
						aria-label="{card.name}, {TRIAGE_LABELS[card.state]}"
						ondragstart={() => (dragging = card)}
						ondragend={() => (dragging = null)}
						onfocus={() => (focused = card.key)}
						onblur={() => (focused = null)}
						onkeydown={(e) => onKey(e, card)}
					>
						<div class="top">
							{#if href}
								<a class="name" {href} draggable="false">{card.name}</a>
							{:else}
								<span class="name">{card.name}</span>
							{/if}
							<button
								type="button"
								class="menu"
								aria-expanded={moving === card.key}
								aria-label="Move {card.name}"
								title="Move"
								onclick={() => (moving = moving === card.key ? null : card.key)}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true"
									><circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle
										cx="12.5"
										cy="8"
										r="1.4"
									/></svg
								>
							</button>
						</div>
						{#if line && card.gig}
							<a class="gig ellipsis" href={card.gig.href} draggable="false">{line}</a>
						{:else if line}
							<span class="gig ellipsis">{line}</span>
						{/if}
						{#if (when && card.column !== 'been') || card.gig?.price || card.warnings.length}
							<p class="foot">
								{#if when && card.column !== 'been'}<span
										class="cd"
										class:strong={card.state === 'tickets'}>{when}</span
									>{/if}
								{#if card.gig?.price && card.column !== 'been' && !card.warnings.includes('sold-out')}<span
										>{card.gig.price}</span
									>{/if}
								{#each card.warnings as w (w)}
									<span class="warn" class:mute={WARNINGS[w].mute} title={WARNINGS[w].title}
										>{WARNINGS[w].text}</span
									>
								{/each}
							</p>
						{/if}
						{#if moving === card.key}
							<div class="moves">
								<TriageButtons
									label="Move {card.name} to"
									states={statesOf(card)}
									current={[card.state]}
									keys
									dense
									fixed
									onpick={(t) => move(card, t)}
									onclear={() => move(card, null)}
								/>
							</div>
						{/if}
					</article>
				{/each}
			</section>
		{/each}
	</div>

	{#if total}
		<p class="how">
			<span class="kbd-hint"
				>Drag cards between columns of their kind, or focus one and press <kbd>2</kbd>
				<kbd>3</kbd> (a gig) or <kbd>1</kbd> <kbd>X</kbd> (an artist).</span
			>{' '}A card's ⋯ button moves it. “Been” fills itself once a gig has passed.
		</p>
	{/if}
</main>

<style>
	.board {
		max-width: 1400px;
		gap: 14px;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 6px 18px;
		flex-wrap: wrap;
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 14px;
		font-size: 12.5px;
		color: var(--mute);
	}
	.sub > * {
		white-space: nowrap;
	}
	.sub a {
		color: var(--amber);
	}
	.sync.synced {
		color: #8fe0b0;
	}
	.sync.error {
		color: var(--bad);
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		padding: 16px;
		border-radius: 10px;
		background: var(--p1);
		color: var(--mute);
		max-width: 640px;
	}
	.empty a:not(.button) {
		color: var(--ink);
	}
	.how {
		font-size: 12px;
		color: var(--mute);
	}

	/* Column tabs: phones only. Five equal cells, so none hides off the edge. */
	.tabs {
		display: none;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 4px;
		padding: 4px;
		border-radius: 12px;
		background: var(--p1);
	}
	.tabs a {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		min-width: 0;
		min-height: 48px;
		padding: 4px 2px;
		border-radius: 9px;
		color: var(--mute);
		text-decoration: none;
	}
	.t-top {
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.t-top b {
		font: 700 15px/1 var(--f-body);
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.t-label {
		max-width: 100%;
		font-size: 10.5px;
		font-weight: 600;
	}
	.tabs a[aria-current] {
		background: var(--p3);
		color: var(--ink);
	}

	.cols {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 12px;
		align-items: start;
	}
	.cols.single {
		grid-template-columns: minmax(0, 480px);
	}
	.col {
		background: var(--p1);
		border-radius: 12px;
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		min-height: 120px;
	}
	.col.faded > :not(header) {
		opacity: 0.8;
	}
	.col.closed {
		opacity: 0.45;
	}
	.group {
		grid-row: 1;
		padding: 0 4px 2px;
		border-bottom: 1px solid var(--line);
		font: 600 10.5px/1.4 var(--f-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink);
	}
	.group span {
		margin-left: 6px;
		color: var(--mute);
		letter-spacing: 0.06em;
	}
	.group.gigs {
		grid-column: 1 / span 3;
	}
	.group.artists {
		grid-column: 4 / span 2;
	}
	.col header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 2px 0;
		min-width: 0;
	}
	.col h2 {
		font: 650 13px/1.2 var(--f-body);
	}
	.col .n {
		margin-left: auto;
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	.play {
		align-self: flex-start;
		height: 32px;
		padding: 0 12px;
		font-size: 12.5px;
	}
	.hint {
		padding: 4px 2px;
		font-size: 12px;
		color: var(--mute);
	}
	.mark {
		width: 9px;
		height: 9px;
		border-radius: 3px;
		flex: none;
	}
	.mark.listen {
		background: var(--listen);
	}
	.mark.go {
		background: var(--go);
	}
	.mark.tickets {
		background: var(--tickets);
	}
	.mark.been {
		background: var(--mute);
	}
	.mark.nope {
		border: 1.5px solid var(--nope);
	}

	.card {
		background: var(--p2);
		border-radius: 8px;
		padding: 8px 6px 10px 14px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		position: relative;
		overflow: hidden;
		outline: none;
	}
	.card::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 4px;
		background: var(--strip);
	}
	.card:focus-visible,
	.card.focused {
		box-shadow: 0 0 0 2px var(--amber);
	}
	@media (hover: hover) {
		.card {
			cursor: grab;
		}
	}
	.top {
		display: flex;
		align-items: flex-start;
		gap: 4px;
	}
	.name {
		flex: 1;
		min-width: 0;
		padding-top: 4px;
		font-size: 14px;
		font-weight: 650;
		line-height: 1.25;
		text-decoration: none;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	a.name:hover {
		text-decoration: underline;
	}
	.menu {
		flex: none;
		width: 30px;
		height: 28px;
		margin: -2px 0 -4px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--mute);
		cursor: pointer;
	}
	.menu svg {
		width: 16px;
		height: 16px;
		fill: currentColor;
	}
	.menu:hover,
	.menu[aria-expanded='true'] {
		background: var(--p3);
		color: var(--ink);
	}
	.gig {
		padding-right: 8px;
		font-size: 12px;
		color: var(--mute);
		text-decoration: none;
		font-variant-numeric: tabular-nums;
	}
	.gig:hover {
		color: var(--ink);
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		padding-right: 8px;
		font-size: 11.5px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
	}
	.foot span {
		white-space: nowrap;
	}
	.cd.strong {
		color: #8fe0b0;
		font-weight: 600;
	}
	.warn {
		color: var(--bad);
	}
	.warn.mute {
		color: var(--mute);
		font-style: italic;
	}
	.moves {
		margin: 8px 8px 0 0;
	}

	/* Narrower windows: the columns scroll sideways, a column at a time. */
	@media (max-width: 1100px) {
		.cols:not(.single) {
			grid-template-columns: repeat(5, minmax(230px, 1fr));
			overflow-x: auto;
			scroll-snap-type: x proximity;
			padding-bottom: 8px;
			margin: 0 -16px;
			padding-inline: 16px;
			scroll-padding-inline: 16px;
		}
		.col {
			scroll-snap-align: start;
		}
	}
	/* Phones: the column tabs pick the one column that shows. */
	@media (max-width: 700px) {
		.tabs {
			display: grid;
		}
		.group {
			display: none;
		}
		.all {
			display: none;
		}
		.cols:not(.single),
		.cols.single {
			display: block;
			overflow: visible;
			margin: 0;
			padding: 0;
		}
		.col:not(.current) {
			display: none;
		}
		.col {
			background: none;
			padding: 0;
		}
		.col header {
			display: none;
		}
		.card {
			padding: 10px 6px 12px 16px;
		}
	}
	@media (pointer: coarse) {
		.menu {
			width: 44px;
			height: 40px;
			margin: -8px -2px -6px 0;
		}
	}
</style>
