<script lang="ts">
	import { page } from '$app/state';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import { apply, parse, summarise, toQuery } from '$lib/data/filters';

	let { data } = $props();
	const catalog = $derived(data.catalog);
	const now = new Date();

	const filters = $derived(parse(page.url.searchParams));
	const shown = $derived(apply(filters, catalog.gigs, now));
	const artists = $derived(new Set(shown.flatMap((v) => v.gig.artists.map((a) => a.key))).size);
	const summary = $derived(
		summarise(filters, {
			city: (key) => catalog.cities.find((c) => c.key === key)?.name ?? key,
			venue: (slug) => catalog.venues[slug]?.name ?? slug
		})
	);
</script>

<svelte:head><title>Radio · giggle</title></svelte:head>

<SiteHeader />
<main class="page">
	<p class="label eyebrow">Radio · coming soon</p>
	<h1 class="display big">Station</h1>
	<p class="summary">{summary}</p>
	<p>
		{shown.length} gigs, {artists} artists. The radio will play 2–3 tracks from each of them and say who
		you're hearing and when they're on.
	</p>
	<p><a class="button" href="/agenda{toQuery(filters)}">See these gigs in the agenda</a></p>
</main>

<style>
	.eyebrow {
		color: var(--amber);
	}
	.big {
		font-size: 64px;
	}
	.summary {
		font-size: 18px;
		font-weight: 600;
	}
</style>
