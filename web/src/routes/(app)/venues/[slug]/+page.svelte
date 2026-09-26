<script lang="ts">
	import GigList from '$lib/components/GigList.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import { amsterdamDate } from '$lib/data/dates';

	let { data } = $props();
	const venue = $derived(data.venue);
	const today = amsterdamDate(new Date());
	const upcoming = $derived(
		data.catalog.gigs.filter((v) => v.gig.venue === venue.slug && v.date >= today)
	);
</script>

<svelte:head><title>{venue.name} · giggle</title></svelte:head>

<SiteHeader />
<main class="page">
	<header class="hero">
		<p class="label">Venue · {venue.city}</p>
		<h1 class="display big">{venue.name}</h1>
		<p class="links">
			<a href={venue.website} rel="external noopener" target="_blank"
				>{venue.website.replace(/^https?:\/\/(www\.)?/, '')} ↗</a
			>
			<a href="/agenda?venue={venue.slug}">Filter the agenda to {venue.name}</a>
		</p>
	</header>
	<section>
		<h2 class="label">{upcoming.length} upcoming gig{upcoming.length === 1 ? '' : 's'}</h2>
		<GigList views={upcoming} {today} showVenue={false} />
	</section>
</main>

<style>
	.hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.big {
		font-size: clamp(48px, 10vw, 80px);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		color: var(--amber);
	}
	.links a {
		color: var(--amber);
	}
</style>
