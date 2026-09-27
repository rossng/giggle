<script lang="ts">
	// One venue: its upcoming gigs, a few weeks at first, the rest a tap away. Its radio station
	// and its website sit next to the title.
	import GigList from '$lib/components/GigList.svelte';
	import { amsterdamDate, weekStart } from '$lib/data/dates';
	import { externalHref } from '$lib/data/slugs';

	let { data } = $props();
	const venue = $derived(data.venue);
	const today = amsterdamDate(new Date());
	const upcoming = $derived(
		data.catalog.gigs.filter((v) => v.gig.venue === venue.slug && v.date >= today)
	);

	/** At first: about 30 gigs, to the end of that week. */
	const FIRST = 30;
	let all = $state(false);
	const cut = $derived.by(() => {
		if (upcoming.length <= FIRST + 10) return upcoming.length;
		const week = weekStart(upcoming[FIRST - 1].date);
		const end = upcoming.findIndex((v, i) => i >= FIRST && weekStart(v.date) !== week);
		return end < 0 ? upcoming.length : end;
	});
	const shown = $derived(all ? upcoming : upcoming.slice(0, cut));
	const site = $derived(venue.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
</script>

<svelte:head><title>{venue.name} · giggle</title></svelte:head>

<main class="page venue">
	<header class="head">
		<div class="name">
			<p class="label">Venue · {venue.city}</p>
			<h1 class="display page-title">{venue.name}</h1>
			<p class="sub">
				{upcoming.length} upcoming gig{upcoming.length === 1 ? '' : 's'} ·
				<a href={externalHref(venue.website)} rel="external noopener" target="_blank">{site} ↗</a>
			</p>
		</div>
		{#if upcoming.length}
			<div class="actions">
				<a class="button strong" href="/radio?venue={venue.slug}">
					<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
						><path d="M3 1.8v8.4L10 6z" fill="currentColor" /></svg
					>
					Play its gigs as radio
				</a>
				<a class="button" href="/agenda?venue={venue.slug}">In the agenda</a>
			</div>
		{/if}
	</header>

	<section class="gigs">
		{#if upcoming.length}
			<GigList views={shown} {today} showVenue={false} />
			{#if shown.length < upcoming.length}
				<button type="button" class="button more" onclick={() => (all = true)}
					>Show all {upcoming.length} gigs</button
				>
			{/if}
		{:else}
			<p class="sub">Nothing listed right now.</p>
		{/if}
	</section>
</main>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px 20px;
		flex-wrap: wrap;
	}
	.name {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}
	.sub {
		font-size: 13px;
		color: var(--mute);
	}
	.sub a {
		color: var(--amber);
		white-space: nowrap;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	.gigs {
		display: flex;
		flex-direction: column;
	}
	.more {
		align-self: center;
		margin-top: 16px;
	}
	@media (max-width: 700px) {
		.actions {
			width: 100%;
		}
		.actions > .button {
			flex: 1 1 0;
			justify-content: center;
		}
	}
</style>
