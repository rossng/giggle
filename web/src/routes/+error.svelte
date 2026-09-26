<script lang="ts">
	import { page } from '$app/state';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
</script>

<svelte:head><title>{page.status} · giggle</title></svelte:head>

<SiteHeader />
<main class="page">
	<p class="label">Error {page.status}</p>
	<h1 class="display big">{page.status === 404 ? 'Not found' : 'Something broke'}</h1>
	<p>{page.error?.message}</p>
	{#if page.status === 503}
		<p class="hint">
			In development, run <code>make data-offline</code> (or <code>make data</code>) to write
			<code>data/site/gigs.json</code> and <code>artists.json</code>, then reload.
		</p>
	{/if}
	<p><a class="button" href="/agenda">Back to the agenda</a></p>
</main>

<style>
	.big {
		font-size: 56px;
	}
	.hint {
		color: var(--mute);
	}
	code {
		font-family: var(--f-mono);
		font-size: 0.9em;
	}
</style>
