<!-- The queue: the current artist highlighted, the ones already played dimmed. -->
<script lang="ts">
	import type { QueueEntry } from '@giggle/radio-core';
	import PosterTile from '$lib/components/PosterTile.svelte';
	import { TRIAGE_LABELS, type Board } from '$lib/board/board';
	import type { Catalog } from '$lib/data/catalog';
	import { formatDay, localDate } from '$lib/data/dates';
	import { NO_GENRE_COLOUR } from '$lib/data/genres';
	import type { Artist } from '$lib/data/types';
	import { artistImage, squareImage } from '$lib/radio/tracks';

	let {
		queue,
		current,
		started,
		board,
		catalog,
		artists,
		onjump
	}: {
		queue: readonly QueueEntry[];
		current: number;
		started: boolean;
		board: Board;
		catalog: Catalog;
		artists: Readonly<Record<string, Artist>>;
		onjump: (index: number) => void;
	} = $props();

	let list: HTMLOListElement | undefined = $state();

	// Keep the current artist in view, scrolling the list only (never the page).
	$effect(() => {
		const index = current;
		const el = list?.children[index] as HTMLElement | undefined;
		if (!list || !el) return;
		const top = el.offsetTop - list.offsetTop;
		if (top < list.scrollTop || top + el.offsetHeight > list.scrollTop + list.clientHeight) {
			list.scrollTop = Math.max(0, top - 8);
		}
	});

	function where(entry: QueueEntry): string {
		const view = catalog.byId.get(entry.gig.id);
		const venue = view?.venueName ?? entry.gig.venue;
		const city = view && view.city !== 'amsterdam' ? `, ${view.cityName}` : '';
		return `${venue}${city} · ${formatDay(localDate(entry.gig.start))}`;
	}
</script>

<ol class="queue" bind:this={list}>
	{#each queue as entry, i (entry.artistKey)}
		{@const state = board[entry.artistKey]?.state}
		{@const view = catalog.byId.get(entry.gig.id)}
		<li class:current={i === current} class:played={started && i < current}>
			<button
				type="button"
				onclick={() => onjump(i)}
				aria-current={i === current ? 'true' : undefined}
				title="Play {entry.name}"
			>
				<PosterTile
					name={entry.name}
					colour={view?.colour ?? NO_GENRE_COLOUR}
					thumb={squareImage(artistImage(artists[entry.artistKey]), 96)}
					size={36}
				/>
				<span class="text">
					<b
						>{entry.name}{#if state}
							<span class="badge b-{state}">{TRIAGE_LABELS[state]}</span>{/if}</b
					>
					<span class="where">{where(entry)}</span>
				</span>
			</button>
		</li>
	{/each}
</ol>

<style>
	.queue {
		list-style: none;
		margin: 0;
		padding: 0 8px 12px;
		overflow-y: auto;
		scrollbar-width: thin;
		min-height: 0;
		flex: 1;
	}
	button {
		all: unset;
		box-sizing: border-box;
		width: 100%;
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr);
		gap: 10px;
		align-items: center;
		padding: 6px 8px;
		border-radius: 8px;
		cursor: pointer;
	}
	button:hover {
		background: var(--p2);
	}
	button:focus-visible {
		outline: 2px solid var(--amber);
	}
	.current button {
		background: var(--p3);
	}
	.played {
		opacity: 0.45;
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	b {
		font-size: 13px;
		font-weight: 650;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge {
		margin-left: 4px;
		vertical-align: 1px;
	}
	.where {
		font-size: 11.5px;
		color: var(--mute);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
