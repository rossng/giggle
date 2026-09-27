<!-- "Play on the radio" for one artist with songs: the app-wide radio jumps to them (or tunes to a
     station that has them) and keeps playing as you browse. Renders nothing without songs. -->
<script lang="ts">
	import type { Catalog } from '$lib/data/catalog';
	import { radioApp } from '$lib/radio/app.svelte';

	let {
		catalog,
		artistKey,
		name,
		compact = false,
		strong = false
	}: {
		catalog: Catalog;
		artistKey: string;
		name: string;
		/** Just the ▶ icon (for rows); the label is still there for screen readers. */
		compact?: boolean;
		strong?: boolean;
	} = $props();

	const playable = $derived(!!catalog.artists[artistKey]?.youtube?.songs?.length);
	const radio = $derived(radioApp.radio(catalog));
	const current = $derived(radio.entry?.artistKey === artistKey);
	const playing = $derived(current && radio.on);
	const label = $derived(playing ? `Pause ${name}` : `Play ${name} on the radio`);

	function onclick() {
		if (current) radio.togglePlay();
		else radioApp.playArtist(catalog, artistKey, name);
	}
</script>

{#if playable}
	<button
		type="button"
		class="play"
		class:button={!compact}
		class:strong
		class:compact
		class:tap={compact}
		class:playing
		aria-label={compact ? label : undefined}
		title={compact ? label : undefined}
		{onclick}
	>
		<svg viewBox="0 0 12 12" aria-hidden="true">
			{#if playing}
				<path d="M2.5 1.5h2.5v9h-2.5zM7 1.5h2.5v9h-2.5z" />
			{:else}
				<path d="M3 1.8v8.4L10 6z" />
			{/if}
		</svg>
		{#if !compact}<span>{playing ? 'Playing now' : 'Play on the radio'}</span>{/if}
	</button>
{/if}

<style>
	svg {
		width: 10px;
		height: 10px;
		fill: currentColor;
		flex: none;
	}
	.playing:not(.strong) {
		border-color: var(--amber);
		color: var(--amber);
	}
	.compact {
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 1px solid var(--line);
		background: none;
		display: grid;
		place-items: center;
		padding: 0;
		cursor: pointer;
		color: var(--ink);
	}
	.compact svg {
		margin-left: 1px;
	}
	.compact:hover {
		border-color: var(--mute);
	}
</style>
