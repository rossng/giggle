<script lang="ts">
	// The app shell, the same on every page: the top bar, the page, and the radio's player bar and
	// video, which live here so moving between pages never stops the music.
	import { untrack } from 'svelte';
	import GigChoice from '$lib/components/shell/GigChoice.svelte';
	import PlayerBar from '$lib/components/shell/PlayerBar.svelte';
	import StationPanel from '$lib/components/shell/StationPanel.svelte';
	import TabBar from '$lib/components/shell/TabBar.svelte';
	import TopBar from '$lib/components/shell/TopBar.svelte';
	import VideoDock from '$lib/components/shell/VideoDock.svelte';
	import { TRIAGES, TRIAGE_KEYS } from '$lib/board/board';
	import { personal } from '$lib/data/personal';
	import { radioApp } from '$lib/radio/app.svelte';

	let { data, children } = $props();
	const catalog = $derived(data.catalog);
	// Made here, once, before anything reactive asks for it (see radioApp.radio).
	const radio = untrack(() => radioApp.radio(data.catalog));
	// Read once per visit, like the pages: station windows are relative to today.
	const now = new Date();

	// Keep the radio tuned to the station (and to the listener's own data it may filter by).
	$effect(() => {
		void radioApp.station;
		radioApp.tune(catalog, personal(), now);
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
		const target = event.target as HTMLElement | null;
		// Typing, or in the settings drawer: not ours. A focused button or link takes the space bar.
		if (target?.closest('input, textarea, select, dialog, [contenteditable]')) return;
		if (event.key === ' ' && target?.closest('button, a, summary')) return;
		const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
		const triageKey = TRIAGES.find((t) => TRIAGE_KEYS[t].toLowerCase() === key);
		const actions: Record<string, () => void> = {
			' ': () => radio.togglePlay(),
			ArrowRight: () => radio.next(),
			ArrowLeft: () => radio.previous(),
			n: () => radio.nextArtist()
		};
		const action = triageKey ? () => radio.triage(triageKey) : actions[key];
		if (!action) return;
		event.preventDefault();
		action();
	}
</script>

<svelte:window {onkeydown} onpagehide={() => radio.save()} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'hidden' && radio.save()} />

<TopBar />
<div class="page-body">
	{@render children()}
</div>
<VideoDock {catalog} />
<PlayerBar {catalog} />
<TabBar />
<StationPanel {catalog} />
<GigChoice {catalog} />

<style>
	.page-body {
		min-height: calc(100dvh - var(--top-h));
		padding-bottom: calc(var(--player-h) + var(--tabs-h));
	}
</style>
