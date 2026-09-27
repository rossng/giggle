<!-- Sorting an artist onto the board: listen more, want to go, got tickets, not for me, each in
     its colour (--listen, --go, --tickets, --nope in app.css). Three sizes: `compact` (the player
     bar: two by two small pills, the label and key; one-word labels on narrower screens), `grid` (the Radio page: key and label, filling the width) and `labelled`
     (the artist page and the Board's card moves: a colour mark and the label, keys optional). -->
<script lang="ts">
	import { TRIAGES, TRIAGE_KEYS, TRIAGE_LABELS, TRIAGE_SHORT, type Triage } from '$lib/board/board';

	let {
		current,
		onpick,
		label,
		size = 'labelled',
		keys = false,
		dense = false,
		fixed = false,
		disabled = false,
		onclear
	}: {
		/** How the artist is sorted now. */
		current: Triage | null;
		onpick: (state: Triage) => void;
		/** The group's accessible name ("Sort this artist"). */
		label: string;
		size?: 'compact' | 'grid' | 'labelled';
		/** `labelled`: show the keyboard shortcuts (1/2/3/X) too. */
		keys?: boolean;
		/** Smaller buttons, for a card. */
		dense?: boolean;
		/** The current state can't be picked again (a move); otherwise picking it unsorts. */
		fixed?: boolean;
		disabled?: boolean;
		/** Adds a "Take off the board" button. */
		onclear?: () => void;
	} = $props();

	function title(t: Triage): string | undefined {
		if (size === 'compact') return `${TRIAGE_LABELS[t]} (${TRIAGE_KEYS[t]})`;
		if (current === t && !fixed) return 'Take them off your board';
		return undefined;
	}
</script>

<div class="triage {size}" class:dense role="group" aria-label={label}>
	<div class="buttons">
		{#each TRIAGES as t (t)}
			<button
				type="button"
				class="t-{t}"
				class:on={current === t && !fixed}
				aria-pressed={current === t}
				disabled={disabled || (fixed && current === t)}
				title={title(t)}
				onclick={() => onpick(t)}
			>
				{#if size === 'compact'}
					<i class="mark" aria-hidden="true"></i>
					<span class="text full">{TRIAGE_LABELS[t]}</span>
					<span class="text short" aria-hidden="true">{TRIAGE_SHORT[t]}</span>
					<kbd>{TRIAGE_KEYS[t]}</kbd>
				{:else}
					{#if size === 'grid'}<kbd>{TRIAGE_KEYS[t]}</kbd>{:else}<i class="mark" aria-hidden="true"
						></i>{/if}
					<span class="text ellipsis">{TRIAGE_LABELS[t]}</span>
					{#if keys}<kbd>{TRIAGE_KEYS[t]}</kbd>{/if}
				{/if}
			</button>
		{/each}
		{#if onclear}
			<button type="button" class="clear" {disabled} onclick={onclear}>Take off the board</button>
		{/if}
	</div>
</div>

<style>
	.buttons {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
	}
	button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		min-width: 0;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--p1);
		color: var(--ink);
		font-weight: 600;
		cursor: pointer;
	}
	.t-listen {
		--t: var(--listen);
	}
	.t-go {
		--t: var(--go);
	}
	.t-tickets {
		--t: var(--tickets);
	}
	.t-nope {
		--t: var(--nope);
		color: var(--mute);
	}
	button:hover:not(:disabled) {
		border-color: var(--mute);
	}
	button.on {
		border-color: transparent;
		background: var(--t);
		color: var(--bg);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button.on kbd {
		background: rgb(0 0 0 / 0.15);
		color: inherit;
		border-color: transparent;
	}
	.text {
		min-width: 0;
	}

	/* The player bar: two by two small pills (colour, label, key), within the bar's height. */
	.compact .buttons {
		grid-template-columns: repeat(2, auto);
		gap: 4px;
	}
	.compact button {
		justify-content: flex-start;
		gap: 6px;
		height: 26px;
		padding: 0 6px 0 8px;
		border: 0;
		border-radius: 7px;
		background: var(--p2);
		color: var(--mute);
		font-size: 11.5px;
		font-weight: 600;
		white-space: nowrap;
	}
	.compact button .text {
		flex: 1;
		text-align: left;
	}
	.compact .short {
		display: none;
	}
	.compact kbd {
		font-size: 9.5px;
		padding: 2px 4px;
	}
	.compact button:disabled {
		opacity: 0.4;
	}
	.compact button:hover:not(:disabled) {
		color: var(--ink);
	}
	.compact button.on {
		background: var(--t);
		color: var(--bg);
	}
	/* Narrower screens: one-word labels, so the bar's controls keep their room. */
	@media (max-width: 920px) {
		.compact .full {
			display: none;
		}
		.compact .short {
			display: inline;
		}
		.compact kbd {
			display: none;
		}
	}

	/* The Radio page: across the width, two by two on phones. */
	.grid .buttons {
		gap: 8px;
	}
	.grid button {
		gap: 8px;
		padding: 10px 8px;
		font-size: 13.5px;
	}
	@media (max-width: 700px) {
		.grid .buttons {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	/* The artist page and card moves: two by two when narrow. */
	.labelled {
		container-type: inline-size;
	}
	.labelled button {
		min-height: 38px;
		padding: 6px 8px;
		font-size: 13px;
	}
	@container (max-width: 440px) {
		.labelled .buttons {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.mark {
		width: 8px;
		height: 8px;
		border-radius: 3px;
		flex: none;
		background: var(--t);
	}
	.t-nope .mark {
		background: none;
		border: 1.5px solid var(--mute);
	}
	button.on .mark {
		background: rgb(0 0 0 / 0.3);
		border-color: transparent;
	}
	/* With keys, the label takes the room and the key sits at the end. */
	.labelled button:has(kbd) {
		justify-content: flex-start;
		text-align: left;
	}
	.labelled button:has(kbd) .text {
		flex: 1;
	}
	.dense .buttons {
		gap: 5px;
	}
	.dense button {
		gap: 6px;
		min-height: 34px;
		padding: 4px 7px;
		border-radius: 7px;
		font-size: 12px;
	}
	.clear {
		grid-column: 1 / -1;
		color: var(--mute);
		font-weight: 500;
	}

	@media (pointer: coarse) {
		.labelled button {
			min-height: 44px;
		}
		.grid button {
			min-height: 48px;
			font-size: 14.5px;
		}
		.dense button {
			font-size: 13px;
		}
	}
</style>
