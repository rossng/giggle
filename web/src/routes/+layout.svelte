<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { sync } from '$lib/sync/app';

	let { children } = $props();

	// Sync (board, unavailable dates, play history) runs for the whole visit; signed out (or
	// with no API) everything just stays on this device.
	onMount(() => {
		sync?.start();
		return () => sync?.stop();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
