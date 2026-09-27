<!-- Free-text search over the gigs. It updates the filters after a pause in typing, not on
     every key, and follows `value` when it changes from elsewhere (e.g. "Clear all"). -->
<script lang="ts">
	import { untrack } from 'svelte';
	import { cleanQuery } from '$lib/data/filters';

	let {
		value,
		onchange,
		id = 'search',
		label = 'Search'
	}: { value: string; onchange: (q: string) => void; id?: string; label?: string } = $props();

	let text = $state(untrack(() => value));
	let timer: ReturnType<typeof setTimeout> | undefined;

	function input(next: string) {
		text = next;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			onchange(cleanQuery(next));
		}, 250);
	}

	function clear() {
		clearTimeout(timer);
		timer = undefined;
		text = '';
		onchange('');
	}

	$effect(() => {
		const q = value;
		untrack(() => {
			if (timer === undefined && cleanQuery(text) !== q) text = q;
		});
	});

	$effect(() => () => clearTimeout(timer));
</script>

<div class="search">
	<label class="visually-hidden" for={id}>{label}</label>
	<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"
		><circle cx="7" cy="7" r="4.6" /><path d="m10.4 10.4 3.4 3.4" /></svg
	>
	<input
		{id}
		type="search"
		placeholder="Artist, venue, title…"
		autocomplete="off"
		spellcheck="false"
		enterkeyhint="search"
		value={text}
		oninput={(e) => input(e.currentTarget.value)}
		onkeydown={(e) => e.key === 'Escape' && text && (e.preventDefault(), clear())}
	/>
	{#if text}
		<button type="button" class="clear" aria-label="Clear search" onclick={clear}>
			<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
		</button>
	{/if}
</div>

<style>
	.search {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.icon {
		position: absolute;
		left: 10px;
		width: 15px;
		height: 15px;
		fill: none;
		stroke: var(--mute);
		stroke-width: 1.6;
		stroke-linecap: round;
		pointer-events: none;
	}
	input {
		width: 100%;
		min-width: 0;
		height: 36px;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 36px 0 32px;
		font-size: 13.5px;
	}
	input::placeholder {
		color: var(--mute);
	}
	input::-webkit-search-cancel-button {
		display: none;
	}
	input:focus {
		border-color: var(--mute);
		outline: none;
	}
	.clear {
		position: absolute;
		right: 2px;
		width: 32px;
		height: 32px;
		border: 0;
		border-radius: 50%;
		background: none;
		display: grid;
		place-items: center;
		cursor: pointer;
		color: var(--mute);
		padding: 0;
	}
	.clear:hover {
		color: var(--ink);
	}
	.clear svg {
		width: 11px;
		height: 11px;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
	}
	@media (pointer: coarse) {
		input {
			height: 44px;
			font-size: 16px; /* no zoom on focus in iOS */
			padding-right: 44px;
		}
		.clear {
			width: 44px;
			height: 44px;
			right: 0;
		}
	}
</style>
