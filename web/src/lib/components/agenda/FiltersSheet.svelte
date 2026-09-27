<!-- The agenda's secondary filters in a modal sheet: a drawer on the right on wide screens, a
     bottom sheet on phones. Filters apply as they're picked; the footer says how many gigs
     that leaves and closes the sheet. -->
<script lang="ts">
	import FilterPanel from '$lib/components/FilterPanel.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import type { Catalog } from '$lib/data/catalog';
	import type { DateWindow, FacetCounts, Filters } from '$lib/data/filters';

	let {
		open = $bindable(false),
		filters,
		catalog,
		counts,
		range,
		shown,
		active,
		onchange,
		onclear
	}: {
		open: boolean;
		filters: Filters;
		catalog: Catalog;
		counts: FacetCounts;
		range: DateWindow;
		/** Gigs the filters leave. */
		shown: number;
		/** Active secondary filters. */
		active: number;
		onchange: (next: Partial<Filters>) => void;
		onclear: () => void;
	} = $props();
</script>

<Sheet bind:open title="Filters" id="agenda-filters">
	{#if open}
		<FilterPanel {filters} {catalog} {counts} {range} {onchange} primary={false} />
	{/if}
	{#snippet footer()}
		<button type="button" class="button reset" disabled={!active} onclick={onclear}>Clear</button>
		<button type="button" class="button strong done" onclick={() => (open = false)}>
			Show {shown} gig{shown === 1 ? '' : 's'}
		</button>
	{/snippet}
</Sheet>

<style>
	.button {
		justify-content: center;
		height: 40px;
		font-size: 13.5px;
	}
	.done {
		flex: 1;
	}
	.reset:disabled {
		opacity: 0.4;
		cursor: default;
	}
	@media (pointer: coarse) {
		.button {
			height: 48px;
			font-size: 15px;
		}
	}
</style>
