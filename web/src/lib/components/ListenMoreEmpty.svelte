<!-- Why a `board=listen` station or agenda is empty, and the way out: nobody marked yet, none of
     them with a gig coming up, none on these filters (then: all their gigs), or (the radio's)
     none with songs. The page says what's empty around it. -->
<script lang="ts">
	import { boardStore } from '$lib/board/board-store.svelte';
	import type { Catalog } from '$lib/data/catalog';
	import { allOfBoard, windowLabel, type Filters } from '$lib/data/filters';
	import { personal } from '$lib/data/personal';

	let {
		filters,
		catalog,
		gigs,
		context,
		onchange
	}: {
		filters: Filters;
		catalog: Catalog;
		/** How many gigs the filters show. */
		gigs: number;
		/** The radio's station, or the agenda's filters. */
		context: 'station' | 'agenda';
		/** Shows (and on the radio, plays) these filters instead. */
		onchange: (next: Filters) => void;
	} = $props();

	const now = new Date();
	const marked = $derived(boardStore.listenMore.size);
	const all = $derived(allOfBoard('listen', catalog.gigs, now, personal()));
	const yours = $derived(
		marked === 1 ? 'Your one listen-more artist' : `None of your ${marked} listen-more artists`
	);
	const has = $derived(marked === 1 ? "doesn't have" : 'has');
	const here = $derived(context === 'station' ? 'on this station' : 'that matches');
	const everyone = $derived({ ...filters, board: null });
	const verb = $derived(context === 'station' ? 'play' : 'show');
	const allLabel = $derived(`${context === 'station' ? 'Play' : 'Show'} all gigs instead`);
	const theirs = $derived(
		all &&
			`${context === 'station' ? 'Play' : 'Show'} all their gigs (${windowLabel(all.days).toLowerCase()})`
	);
</script>

{#if marked === 0}
	<p>
		You haven't marked anyone listen more yet. On the <a href="/radio">radio</a>, press Listen more
		on an artist you'd like to hear again<span class="kbd-hint">&nbsp;(<kbd>1</kbd>)</span>, or do
		it on their page, and they'll {verb} here.
	</p>
	<div class="actions">
		<button type="button" class="button strong" onclick={() => onchange(everyone)}
			>{allLabel}</button
		>
	</div>
{:else if !all}
	<p>{yours} {has} a gig coming up in the listings. They'll {verb} here once one is announced.</p>
	<div class="actions">
		<button type="button" class="button strong" onclick={() => onchange(everyone)}
			>{allLabel}</button
		>
	</div>
{:else if gigs === 0}
	<p>{yours} {has} a gig {here}, but they do have gigs coming up.</p>
	<div class="actions">
		<button type="button" class="button strong" onclick={() => onchange(all)}>{theirs}</button>
		<button type="button" class="button" onclick={() => onchange(everyone)}>{allLabel}</button>
	</div>
{:else}
	<p>
		None of your listen-more artists {here} has songs on YouTube Music, so there's nothing to play.
	</p>
{/if}

<style>
	p {
		margin: 0;
		color: var(--mute);
		max-width: 60ch;
	}
	p a {
		color: var(--ink);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
