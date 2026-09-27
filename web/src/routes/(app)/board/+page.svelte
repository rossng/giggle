<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import {
		BOARD_STORAGE_KEY,
		loadBoard,
		saveBoard,
		setTriage,
		TRIAGE_KEYS,
		TRIAGE_LABELS,
		TRIAGES,
		type Board,
		type Triage
	} from '$lib/board/board';
	import { boardColumns, COLUMNS, type Card, type ColumnId } from '$lib/board/columns';
	import { amsterdamDate, dayParts, localDate, localTime } from '$lib/data/dates';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';
	import { artistPath } from '$lib/data/slugs';
	import type { SyncStatus } from '$lib/sync/client';
	import { boardChanged, onBoardSynced, sync as syncClient } from '$lib/sync/app';

	let { data } = $props();
	const catalog = $derived(data.catalog);

	let board: Board = $state({});
	const today = amsterdamDate(new Date());
	const columns = $derived(boardColumns(board, catalog, today, unavailableDates.test));
	const total = $derived(Object.keys(board).length);
	// /board?column=go shows one column (the URL shape agreed for deep links).
	const only = $derived(page.url.searchParams.get('column') as ColumnId | null);
	const shown = $derived(COLUMNS.filter((c) => !only || c.id === only));

	let focused: string | null = $state(null);
	let sync: SyncStatus | null = $state(null);
	const SYNC_TEXT: Record<SyncStatus['state'], string> = {
		synced: 'Synced',
		syncing: 'Syncing…',
		offline: 'On this device only',
		'signed-out': 'Not signed in: on this device only',
		error: 'Sync problem'
	};
	let dragging: string | null = $state(null);

	onMount(() => {
		board = loadBoard();
		// Another tab (the radio) changed the board.
		const onStorage = (e: StorageEvent) => {
			if (e.key === BOARD_STORAGE_KEY) board = loadBoard();
		};
		addEventListener('storage', onStorage);
		const offSync = onBoardSynced((synced) => (board = synced));
		const offStatus = syncClient?.subscribe((s) => (sync = s)) ?? (() => {});
		return () => {
			removeEventListener('storage', onStorage);
			offSync();
			offStatus();
		};
	});

	function move(card: Card, state: Triage | null) {
		const meta = {
			name: card.name,
			...(card.item.gig ? { gig: card.item.gig } : {}),
			...(card.item.when ? { when: card.item.when } : {})
		};
		board = setTriage(board, card.key, state, meta, new Date());
		saveBoard(board);
		boardChanged();
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
		}
	}

	function gigLine(card: Card): string | null {
		const v = card.next ?? card.sortedFrom;
		if (!v) return null;
		const d = dayParts(localDate(v.gig.start));
		return `${d.weekday} ${d.day} ${d.month} · ${v.venueName}${v.cityName !== 'Amsterdam' ? `, ${v.cityName}` : ''} · ${localTime(v.gig.start)}`;
	}

	function countdown(card: Card): string | null {
		if (card.inDays === null) return null;
		if (card.inDays === 0) return 'today';
		if (card.inDays === 1) return 'tomorrow';
		if (card.inDays < 14) return `in ${card.inDays} days`;
		return `in ${Math.round(card.inDays / 7)} wks`;
	}
</script>

<svelte:head><title>Board · giggle</title></svelte:head>

<SiteHeader />
<main class="page board">
	<header class="head">
		<div>
			<p class="label eyebrow">Your board</p>
			<h1 class="display big">Board</h1>
			<p class="sub">
				{#if total}
					{total} artists. Sort them from the radio with <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>
					<kbd>X</kbd>, or here: drag a card, or focus it and press a key.
				{:else}
					Nothing sorted yet. On the <a href="/radio">radio</a>, press <kbd>1</kbd> listen more,
					<kbd>2</kbd> want to go, <kbd>3</kbd> got tickets, <kbd>X</kbd> not for me.
				{/if}
			</p>
		</div>
		<div class="side">
			{#if sync}
				<span class="sync {sync.state}" title={sync.error ?? sync.user ?? ''}
					>{SYNC_TEXT[sync.state]}{sync.pending ? ` · ${sync.pending} to send` : ''}</span
				>
			{/if}
			{#if only}<a class="all" href="/board">Show all columns</a>{/if}
		</div>
	</header>

	<div class="cols" class:single={!!only}>
		{#each shown as column (column.id)}
			<section
				class="col"
				class:faded={column.id === 'been' || column.id === 'nope'}
				aria-labelledby="col-{column.id}"
				ondragover={(e) => {
					if (column.id !== 'been') e.preventDefault();
				}}
				ondrop={() => drop(column.id)}
			>
				<header>
					<em class="dot {column.id}"></em>
					<h2 id="col-{column.id}">{column.label}</h2>
					<i>{columns[column.id].length}</i>
				</header>
				<p class="hint">{column.hint}</p>
				{#each columns[column.id] as card (card.key)}
					<!-- Cards are focusable so 1/2/3/X re-sort them from the keyboard, as on the radio;
					     the same moves are also buttons inside the card. -->
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
						<b>
							{#if catalog.artists[card.key]}
								<a href={artistPath(catalog.artists[card.key])}>{card.name}</a>
							{:else}
								{card.name}
							{/if}
						</b>
						{#if gigLine(card)}<span class="gig">{gigLine(card)}</span>{/if}
						<div class="foot">
							{#if countdown(card)}<span class="cd" class:strong={card.state === 'tickets'}
									>{countdown(card)}</span
								>{/if}
							{#if card.next?.price && card.column !== 'been'}<span>{card.next.price}</span>{/if}
							{#if card.warnings.includes('sold-out')}<span class="warn"
									>Sold out · check resale</span
								>{/if}
							{#if card.warnings.includes('no-gig')}<span class="warn mute"
									>No upcoming gig in the data</span
								>{/if}
							{#if card.warnings.includes('unavailable')}<span
									class="warn"
									title="On one of your unavailable dates">You're unavailable that day</span
								>{/if}
						</div>
						<div class="moves" aria-label="Move {card.name}">
							{#each TRIAGES as t (t)}
								{#if t !== card.state}
									<button type="button" onclick={() => move(card, t)} title={TRIAGE_LABELS[t]}
										><kbd>{TRIAGE_KEYS[t]}</kbd></button
									>
								{/if}
							{/each}
							<button type="button" class="remove" onclick={() => move(card, null)} title="Remove"
								>×</button
							>
						</div>
					</article>
				{/each}
			</section>
		{/each}
	</div>
</main>

<style>
	.board {
		max-width: none;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 16px;
		flex-wrap: wrap;
	}
	.eyebrow {
		color: var(--amber);
	}
	.big {
		font-size: 64px;
		margin: 0;
	}
	.sub {
		color: var(--mute);
		max-width: 70ch;
	}
	.all {
		color: var(--amber);
	}
	.side {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
	}
	.sync {
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--mute);
	}
	.sync.synced {
		color: #8fe0b0;
	}
	.sync.error {
		color: var(--bad);
	}
	kbd {
		font: 600 10px/1 var(--f-mono);
		background: var(--bg);
		color: var(--mute);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 3px 5px;
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(5, minmax(200px, 1fr));
		gap: 12px;
		align-items: start;
		margin-top: 20px;
		overflow-x: auto;
		padding-bottom: 8px;
	}
	.cols.single {
		grid-template-columns: minmax(0, 480px);
	}
	.col {
		background: var(--p1);
		border-radius: 10px;
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		min-height: 120px;
	}
	.col.faded {
		opacity: 0.8;
	}
	.col header {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.col h2 {
		font: 650 13px/1.2 var(--f-body);
		margin: 0;
	}
	.col header i {
		margin-left: auto;
		font: 500 11px var(--f-mono);
		font-style: normal;
		color: var(--mute);
	}
	.hint {
		margin: -4px 0 2px;
		font-size: 11px;
		color: var(--mute);
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 3px;
	}
	.dot.listen {
		background: #8ea3ff;
	}
	.dot.go {
		background: var(--amber);
	}
	.dot.tickets {
		background: #7fd1a0;
	}
	.dot.been {
		background: var(--mute);
	}
	.dot.nope {
		border: 1.5px solid var(--mute);
	}
	.card {
		background: var(--p2);
		border-radius: 8px;
		padding: 10px 11px 10px 14px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		position: relative;
		overflow: hidden;
		cursor: grab;
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
	.card b {
		font-size: 13.5px;
	}
	.card b a {
		color: inherit;
		text-decoration: none;
	}
	.card b a:hover {
		text-decoration: underline;
	}
	.gig {
		font-size: 11.5px;
		color: var(--mute);
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		margin-top: 4px;
		font-size: 11px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
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
		display: flex;
		gap: 4px;
		margin-top: 6px;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.card:hover .moves,
	.card:focus-within .moves {
		opacity: 1;
	}
	.moves button {
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		color: var(--mute);
		font: inherit;
	}
	.moves .remove {
		margin-left: auto;
		font-size: 15px;
		line-height: 1;
	}
	@media (hover: none) {
		.moves {
			opacity: 1;
		}
	}
	@media (max-width: 860px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.moves {
			transition: none;
		}
	}
</style>
