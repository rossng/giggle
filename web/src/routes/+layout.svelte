<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { boardSync } from '$lib/sync/app';

	let { children } = $props();

	// Board sync runs for the whole visit; signed out (or no API) it just stays local.
	onMount(() => {
		boardSync?.start();
		return () => boardSync?.stop();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
