<!-- Which gig? Want to go or got tickets, pressed on the radio for an artist with more than one gig
     on the station (`radio.choosing`): their gigs, soonest first, each with how it's sorted now.
     Picking one sorts it, or unsorts it if it's sorted so already; 1–9 pick from the keyboard. -->
<script lang="ts">
	import Sheet from '$lib/components/Sheet.svelte';
	import { TRIAGE_LABELS } from '$lib/board/board';
	import { boardStore } from '$lib/board/board-store.svelte';
	import type { Catalog } from '$lib/data/catalog';
	import { dayParts, localDate, localTime } from '$lib/data/dates';
	import { radioApp } from '$lib/radio/app.svelte';

	let { catalog }: { catalog: Catalog } = $props();

	const radio = $derived(radioApp.radio(catalog));
	const choice = $derived(radio.choosing);

	function place(gigId: string, fallback: string): string {
		const v = catalog.byId.get(gigId);
		if (!v) return fallback;
		return v.city !== 'amsterdam' ? `${v.venueName}, ${v.cityName}` : v.venueName;
	}

	function onkeydown(e: KeyboardEvent) {
		if (!choice || e.metaKey || e.ctrlKey || e.altKey) return;
		// Only keys pressed in the dialog: not the 2 or 3 that opened it.
		if (!(e.target instanceof Element) || !e.target.closest('#gig-choice')) return;
		const gig = /^[1-9]$/.test(e.key) ? choice.gigs[Number(e.key) - 1] : undefined;
		if (!gig) return;
		e.preventDefault();
		radio.choose(gig);
	}
</script>

<svelte:window {onkeydown} />

<Sheet
	id="gig-choice"
	kind="modal"
	bind:open={() => !!choice, (open) => !open && (radio.choosing = null)}
	title={choice ? `${TRIAGE_LABELS[choice.state]}: which gig?` : ''}
>
	{#if choice}
		<div class="choice">
			<p class="lead">{choice.artist.name} has {choice.gigs.length} gigs on this station.</p>
			<ul>
				{#each choice.gigs as gig, i (gig.id)}
					{@const d = dayParts(localDate(gig.start))}
					{@const state = boardStore.gigState(gig.id)}
					<li>
						<button
							type="button"
							aria-pressed={state === choice.state}
							onclick={() => radio.choose(gig)}
						>
							{#if i < 9}<kbd>{i + 1}</kbd>{/if}
							<span class="when">{d.weekday} {d.day} {d.month} · {localTime(gig.start)}</span>
							<span class="where ellipsis">{place(gig.id, gig.venue)}</span>
							{#if state}<span class="badge b-{state}">{TRIAGE_LABELS[state]}</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
			<p class="hint">Picking a gig that's already “{TRIAGE_LABELS[choice.state]}” takes it off.</p>
		</div>
	{/if}
</Sheet>

<style>
	.choice {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.lead,
	.hint {
		font-size: 13px;
		color: var(--mute);
	}
	.hint {
		font-size: 12px;
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 44px;
		padding: 8px 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--p2);
		color: var(--ink);
		font-size: 13.5px;
		text-align: left;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--mute);
	}
	button[aria-pressed='true'] {
		border-color: var(--amber);
	}
	.when {
		flex: none;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.where {
		flex: 1;
		min-width: 0;
		color: var(--mute);
	}
</style>
