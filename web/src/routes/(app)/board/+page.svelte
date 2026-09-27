<script lang="ts">
	// The Board: the artists you've sorted, in columns (listen more, want to go, got tickets,
	// been, not for me). The columns are the page. Each card has a ⋯ button to move it; with a
	// mouse, cards also drag, and a focused card takes 1/2/3/X like the radio. On phones one
	// column shows at a time, picked from the row of column tabs.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		BOARD_STORAGE_KEY,
		TRIAGE_KEYS,
		TRIAGE_LABELS,
		TRIAGES,
		type Triage
	} from '$lib/board/board';
	import {
		boardColumns,
		COLUMNS,
		countdownText,
		type Card,
		type ColumnId
	} from '$lib/board/columns';
	import { liveBoard, reloadBoard, sortArtist } from '$lib/board/live';
	import { amsterdamDate, dayParts, localDate, localTime } from '$lib/data/dates';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';
	import { artistPath } from '$lib/data/slugs';
	import type { SyncStatus } from '$lib/sync/client';
	import { sync as syncClient } from '$lib/sync/app';

	let { data } = $props();
	const catalog = $derived(data.catalog);

	const board = $derived(liveBoard(catalog));
	const today = amsterdamDate(new Date());
	const columns = $derived(boardColumns(board, catalog, today, unavailableDates.test));
	const total = $derived(Object.keys(board).length);
	// /board?column=go shows one column (the URL shape agreed for deep links).
	const only = $derived(
		COLUMNS.find((c) => c.id === page.url.searchParams.get('column'))?.id ?? null
	);
	const shown = $derived(COLUMNS.filter((c) => !only || c.id === only));
	/** On phones, the one column showing: the URL's, else the first of yours with anyone in it. */
	const current = $derived<ColumnId>(
		only ?? (['go', 'tickets', 'listen'] as const).find((id) => columns[id].length) ?? 'listen'
	);

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
	let dragging: string | null = $state(null);

	onMount(() => {
		// Another tab (the radio in another window) changed the board.
		const onStorage = (e: StorageEvent) => {
			if (e.key === BOARD_STORAGE_KEY) reloadBoard(catalog);
		};
		addEventListener('storage', onStorage);
		const offStatus = syncClient?.subscribe((s) => (sync = s)) ?? (() => {});
		return () => {
			removeEventListener('storage', onStorage);
			offStatus();
		};
	});

	function move(card: Card, state: Triage | null) {
		moving = null;
		sortArtist(catalog, card.key, state, {
			name: card.name,
			...(card.item.gig ? { gig: card.item.gig } : {}),
			...(card.item.when ? { when: card.item.when } : {})
		});
	}

	/** Dropping onto Been doesn't change anything: it follows the gig date. */
	function drop(column: ColumnId) {
		const card = Object.values(columns)
			.flat()
			.find((c) => c.key === dragging);
		dragging = null;
		if (card && column !== 'been' && card.state !== column) move(card, column);
	}

	function onKey(e: KeyboardEvent, card: Card) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const key = e.key.toLowerCase();
		const state = TRIAGES.find((t) => TRIAGE_KEYS[t].toLowerCase() === key);
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

	function gigLine(card: Card): string | null {
		const v = card.next ?? card.sortedFrom;
		if (!v) return null;
		const d = dayParts(localDate(v.gig.start));
		const place = v.cityName !== 'Amsterdam' ? `${v.venueName}, ${v.cityName}` : v.venueName;
		return `${d.weekday} ${d.day} ${d.month} · ${localTime(v.gig.start)} · ${place}`;
	}

	const WARNINGS = {
		'sold-out': { text: 'Sold out', title: 'Sold out: check resale', mute: false },
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
				<span>{total} artist{total === 1 ? '' : 's'}</span>
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
				Nothing sorted yet. On the <a href="/radio">radio</a>, sort who's playing: listen more, want
				to go, got tickets or not for me<span class="kbd-hint">
					(keys <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>X</kbd>)</span
				>. They land here.
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
				<span class="t-label">{column.label}</span>
			</a>
		{/each}
	</nav>

	<div class="cols" class:single={!!only}>
		{#each shown as column (column.id)}
			<section
				class="col"
				class:current={current === column.id}
				class:faded={column.id === 'been' || column.id === 'nope'}
				aria-labelledby="col-{column.id}"
				ondragover={(e) => {
					if (column.id !== 'been') e.preventDefault();
				}}
				ondrop={() => drop(column.id)}
			>
				<header title={column.hint}>
					<i class="mark {column.id}" aria-hidden="true"></i>
					<h2 id="col-{column.id}">{column.label}</h2>
					<span class="n">{columns[column.id].length}</span>
				</header>
				{#if !columns[column.id].length}
					<p class="hint">{column.hint}.</p>
				{/if}
				{#each columns[column.id] as card (card.key)}
					{@const line = gigLine(card)}
					{@const when = countdownText(card.inDays)}
					{@const artist = catalog.artists[card.key]}
					<!-- Cards are focusable so 1/2/3/X re-sort them from the keyboard, as on the radio;
					     the same moves are behind the card's ⋯ button. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
					<article
						class="card"
						class:focused={focused === card.key}
						style:--strip={card.next?.colour ?? card.sortedFrom?.colour ?? 'var(--p3)'}
						draggable="true"
						tabindex="0"
						aria-label="{card.name}, {TRIAGE_LABELS[card.state]}"
						ondragstart={() => (dragging = card.key)}
						ondragend={() => (dragging = null)}
						onfocus={() => (focused = card.key)}
						onblur={() => (focused = null)}
						onkeydown={(e) => onKey(e, card)}
					>
						<div class="top">
							{#if artist}
								<a class="name" href={artistPath(artist)} draggable="false">{card.name}</a>
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
						{#if line}
							{@const v = card.next ?? card.sortedFrom}
							<a class="gig" href={v?.href} draggable="false">{line}</a>
						{/if}
						{#if (when && card.column !== 'been') || card.next?.price || card.warnings.length}
							<p class="foot">
								{#if when && card.column !== 'been'}<span
										class="cd"
										class:strong={card.state === 'tickets'}>{when}</span
									>{/if}
								{#if card.next?.price && card.column !== 'been' && !card.warnings.includes('sold-out')}<span
										>{card.next.price}</span
									>{/if}
								{#each card.warnings as w (w)}
									<span class="warn" class:mute={WARNINGS[w].mute} title={WARNINGS[w].title}
										>{WARNINGS[w].text}</span
									>
								{/each}
							</p>
						{/if}
						{#if moving === card.key}
							<div class="moves" role="group" aria-label="Move {card.name} to">
								{#each TRIAGES as t (t)}
									<button
										type="button"
										class="s-{t}"
										aria-pressed={card.state === t}
										disabled={card.state === t}
										onclick={() => move(card, t)}
										><i class="mark {t}" aria-hidden="true"></i><span>{TRIAGE_LABELS[t]}</span><kbd
											>{TRIAGE_KEYS[t]}</kbd
										></button
									>
								{/each}
								<button type="button" class="remove" onclick={() => move(card, null)}
									>Take off the board</button
								>
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
				>Drag cards between columns, or focus one and press <kbd>1</kbd> <kbd>2</kbd>
				<kbd>3</kbd> <kbd>X</kbd>.</span
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
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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
	.col header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 2px 0;
		min-width: 0;
	}
	.col h2 {
		font: 650 13px/1.2 var(--f-body);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.col .n {
		margin-left: auto;
		font: 500 11px var(--f-mono);
		color: var(--mute);
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
		background: #8ea3ff;
	}
	.mark.go {
		background: var(--amber);
	}
	.mark.tickets {
		background: #7fd1a0;
	}
	.mark.been {
		background: var(--mute);
	}
	.mark.nope {
		border: 1.5px solid var(--mute);
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
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 5px;
		margin: 8px 8px 0 0;
	}
	.moves button {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		min-height: 34px;
		padding: 4px 7px;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--p1);
		color: var(--ink);
		font-size: 12px;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}
	.moves button span {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.moves button:hover:not(:disabled) {
		border-color: var(--mute);
	}
	.moves button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.moves .remove {
		grid-column: 1 / -1;
		justify-content: center;
		color: var(--mute);
		font-weight: 500;
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
		.moves button {
			min-height: 44px;
			font-size: 13px;
		}
	}
</style>
