<script lang="ts">
	import SiteHeader from '$lib/components/SiteHeader.svelte';

	const columns = ['Listen more', 'Want to go', 'Got tickets', 'Been', 'Not for me'];
</script>

<svelte:head><title>Board · giggle</title></svelte:head>

<SiteHeader />
<main class="page">
	<p class="label eyebrow">Board · coming soon</p>
	<h1 class="display big">Board</h1>
	<p>Sort artists from the radio into columns, synced across your devices:</p>
	<ul class="tags">
		{#each columns as column (column)}<li>{column}</li>{/each}
	</ul>
</main>

<style>
	.eyebrow {
		color: var(--amber);
	}
	.big {
		font-size: 64px;
	}
</style>
