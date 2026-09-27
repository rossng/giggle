<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { preloadCode } from '$app/navigation';
	import favicon from '$lib/assets/favicon.svg';
	import { PAGE_PATHS, whenIdle } from '$lib/pages';
	import { sync } from '$lib/sync/app';

	let { children } = $props();

	// Sync (board, unavailable dates, play history) runs for the whole visit; signed out (or
	// with no API) everything just stays on this device.
	onMount(() => {
		sync?.start();
		return () => sync?.stop();
	});

	// Every page's code up front, so a deploy mid-visit never forces a reload (lib/pages.ts).
	onMount(() =>
		whenIdle(() => {
			for (const path of PAGE_PATHS) void preloadCode(path).catch(() => {});
		})
	);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
