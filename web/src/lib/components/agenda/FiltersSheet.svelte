<!-- The agenda's secondary filters in a modal sheet: a drawer on the right on wide screens, a
     bottom sheet on phones. Filters apply as they're picked; the footer says how many gigs
     that leaves and closes the sheet. -->
<script lang="ts">
	import FilterPanel from '$lib/components/FilterPanel.svelte';
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

	let dialog: HTMLDialogElement | undefined = $state();
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	id="agenda-filters"
	class="sheet"
	aria-labelledby="agenda-filters-title"
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && dialog?.close()}
>
	<div class="frame">
		<header>
			<h2 class="display" id="agenda-filters-title">Filters</h2>
			<button
				type="button"
				class="close"
				onclick={() => dialog?.close()}
				aria-label="Close filters"
			>
				<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
			</button>
		</header>
		<div class="body">
			{#if open}
				<FilterPanel {filters} {catalog} {counts} {range} {onchange} primary={false} />
			{/if}
		</div>
		<footer>
			<button type="button" class="button reset" disabled={!active} onclick={onclear}>Clear</button>
			<button type="button" class="button strong done" onclick={() => dialog?.close()}>
				Show {shown} gig{shown === 1 ? '' : 's'}
			</button>
		</footer>
	</div>
</dialog>

<style>
	.sheet {
		margin: 0 0 0 auto;
		width: min(420px, 100vw);
		height: 100dvh;
		max-width: 100vw;
		max-height: 100dvh;
		padding: 0;
		border: 0;
		border-left: 1px solid var(--line);
		background: var(--p1);
		color: var(--ink);
		overscroll-behavior: contain;
	}
	.sheet::backdrop {
		background: rgb(0 0 0 / 0.5);
	}
	.frame {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 16px 12px 20px;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		font-size: 32px;
	}
	.close {
		width: 36px;
		height: 36px;
		border: 0;
		border-radius: 50%;
		background: var(--p2);
		display: grid;
		place-items: center;
		cursor: pointer;
		padding: 0;
	}
	.close svg {
		width: 12px;
		height: 12px;
		stroke: var(--ink);
		stroke-width: 1.7;
		stroke-linecap: round;
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 18px 20px 28px;
		scrollbar-width: thin;
	}
	footer {
		display: flex;
		gap: 10px;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--line);
		background: var(--p1);
	}
	footer .button {
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

	/* Phones: a sheet from the bottom, most of the screen tall. */
	@media (max-width: 700px) {
		.sheet {
			margin: auto 0 0;
			width: 100vw;
			height: min(88dvh, 100dvh - 24px);
			border-left: 0;
			border-top: 1px solid var(--line);
			border-radius: 16px 16px 0 0;
		}
		header {
			padding: 12px 12px 10px 16px;
		}
		.body {
			padding: 14px 16px 24px;
		}
	}
	@media (pointer: coarse) {
		.close {
			width: 44px;
			height: 44px;
		}
		footer .button {
			height: 48px;
			font-size: 15px;
		}
	}
</style>
