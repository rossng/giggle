<!-- The time window: how far ahead (segmented) and from when (a compact select). -->
<script lang="ts">
	import { DAY_PRESETS, FROM_PRESETS, type Filters } from '$lib/data/filters';

	let {
		days,
		from,
		onchange,
		stretch = false
	}: {
		days: number;
		from: number;
		onchange: (next: Partial<Filters>) => void;
		/** Fill the width (in a narrow panel) rather than size to the content. */
		stretch?: boolean;
	} = $props();

	const starts = $derived(
		FROM_PRESETS.some((p) => p.from === from)
			? FROM_PRESETS
			: [...FROM_PRESETS, { from, label: `+${from} days` }]
	);
	const customDays = $derived(!DAY_PRESETS.some((p) => p.days === days));
</script>

<div class="when" class:stretch>
	<div class="seg" role="group" aria-label="How far ahead">
		{#each DAY_PRESETS as p (p.days)}
			<button
				type="button"
				aria-pressed={days === p.days}
				onclick={() => onchange({ days: p.days })}>{p.label}</button
			>
		{/each}
		{#if customDays}<button type="button" aria-pressed="true">{days} days</button>{/if}
	</div>
	<label class="from">
		<span class="visually-hidden">Starting</span>
		<select value={from} onchange={(e) => onchange({ from: Number(e.currentTarget.value) })}>
			{#each starts as p (p.from)}
				<option value={p.from}>{p.from === 0 ? 'From today' : `From ${p.label}`}</option>
			{/each}
		</select>
		<svg viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" /></svg>
	</label>
</div>

<style>
	.when {
		display: flex;
		gap: 6px;
		min-width: 0;
	}
	.seg {
		display: flex;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 2px;
		gap: 2px;
		min-width: 0;
	}
	.stretch .seg {
		flex: 1;
	}
	.seg button {
		flex: 1;
		border: 0;
		background: none;
		height: 30px;
		padding: 0 10px;
		border-radius: 999px;
		font-size: 12.5px;
		color: var(--mute);
		white-space: nowrap;
		cursor: pointer;
	}
	.seg button:hover {
		color: var(--ink);
	}
	.seg button[aria-pressed='true'] {
		background: var(--p3);
		color: var(--ink);
		font-weight: 600;
	}
	.from {
		position: relative;
		display: flex;
		align-items: center;
		flex: none;
	}
	select {
		appearance: none;
		height: 36px;
		background: var(--p1);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 28px 0 12px;
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	select:hover {
		border-color: var(--mute);
	}
	.from svg {
		position: absolute;
		right: 11px;
		width: 9px;
		height: 6px;
		fill: none;
		stroke: var(--mute);
		stroke-width: 1.5;
		pointer-events: none;
	}
	@media (pointer: coarse) {
		.seg button {
			height: 40px;
			padding: 0 6px;
		}
		select {
			height: 44px;
			font-size: 14px;
		}
	}
</style>
