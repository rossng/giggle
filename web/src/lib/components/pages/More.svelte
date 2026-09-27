<!-- A section that starts closed: the page shows what people come for, and the rest is one tap
     away. `summary` says what's inside ("bio · tags · similar artists"). -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		summary = '',
		open = $bindable(false),
		children
	}: { label: string; summary?: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="more" bind:open>
	<summary>
		<span class="label">{label}</span>
		{#if summary}<span class="what ellipsis">{summary}</span>{/if}
		<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
	</summary>
	<div class="body">
		{@render children()}
	</div>
</details>

<style>
	.more {
		border-top: 1px solid var(--line);
	}
	.more:last-child {
		border-bottom: 1px solid var(--line);
	}
	summary {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		padding: 6px 2px;
		cursor: pointer;
		list-style: none;
		user-select: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary .label {
		flex: none;
		color: var(--ink);
	}
	.what {
		flex: 1;
		min-width: 0;
		font-size: 12.5px;
		color: var(--mute);
	}
	.chev {
		flex: none;
		margin-left: auto;
		width: 14px;
		height: 14px;
		fill: none;
		stroke: var(--mute);
		stroke-width: 1.5;
		transition: transform 0.15s;
	}
	summary:hover .chev,
	summary:hover .label {
		stroke: var(--ink);
	}
	.more[open] .chev {
		transform: rotate(180deg);
	}
	.body {
		padding: 4px 0 22px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
</style>
