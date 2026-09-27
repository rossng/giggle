<!-- The active filters beyond search and dates, each a chip that removes it when tapped, and
     "Clear" for all of them. One line: it scrolls sideways on phones and wraps on wide screens. -->
<script lang="ts">
	import type { ActiveFilter, Filters } from '$lib/data/filters';

	let {
		chips,
		onchange,
		onclear
	}: {
		chips: ActiveFilter[];
		onchange: (next: Partial<Filters>) => void;
		onclear: () => void;
	} = $props();
</script>

<div class="active" role="group" aria-label="Active filters">
	<ul>
		{#each chips as chip (chip.id)}
			<li>
				<button
					type="button"
					class="chip"
					aria-label="Remove filter: {chip.label}"
					title="Remove"
					onclick={() => onchange(chip.without)}
				>
					{#if chip.colour}<span class="dot" style:background={chip.colour}></span>{/if}
					<span class="text">{chip.label}</span>
					<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
				</button>
			</li>
		{/each}
	</ul>
	{#if chips.length > 1}
		<button type="button" class="clear" onclick={onclear}>Clear</button>
	{/if}
</div>

<style>
	.active {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
	}
	ul {
		flex: 1;
		min-width: 0;
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 30px;
		max-width: 260px;
		padding: 0 9px 0 12px;
		border-radius: 999px;
		border: 1px solid var(--amber);
		background: var(--p2);
		color: var(--ink);
		font-size: 12.5px;
		white-space: nowrap;
		cursor: pointer;
	}
	.text {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chip svg {
		flex: none;
		width: 10px;
		height: 10px;
		stroke: var(--mute);
		stroke-width: 1.7;
		stroke-linecap: round;
	}
	.chip:hover svg {
		stroke: var(--ink);
	}
	.clear {
		flex: none;
		height: 30px;
		border: 0;
		background: none;
		padding: 0 4px;
		font-size: 12.5px;
		color: var(--mute);
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	.clear:hover {
		color: var(--ink);
	}

	/* Phones: one line that scrolls sideways, fading out at the edge; Clear stays in view. */
	@media (max-width: 700px) {
		ul {
			flex-wrap: nowrap;
			overflow-x: auto;
			scrollbar-width: none;
			mask-image: linear-gradient(90deg, #000 calc(100% - 20px), transparent);
			padding-right: 20px;
		}
		ul::-webkit-scrollbar {
			display: none;
		}
		li {
			flex: none;
		}
	}
	@media (pointer: coarse) {
		.chip {
			height: 40px;
			padding: 0 12px 0 14px;
			font-size: 13px;
		}
		.clear {
			height: 40px;
			padding: 0 8px;
			font-size: 13px;
		}
	}
</style>
