<script lang="ts">
	import type { GigView } from '$lib/data/catalog';
	import { weekLabel, weekStart } from '$lib/data/dates';
	import type { IsoDate } from '$lib/data/types';
	import GigRow from './GigRow.svelte';

	let {
		views,
		today,
		showVenue = true
	}: { views: GigView[]; today: IsoDate; showVenue?: boolean } = $props();

	/** Consecutive runs of gigs in the same Monday-to-Sunday week. */
	const weeks = $derived.by(() => {
		const out: { monday: IsoDate; label: string; views: GigView[] }[] = [];
		for (const view of views) {
			const monday = weekStart(view.date);
			let week = out.at(-1);
			if (!week || week.monday !== monday) {
				week = { monday, label: weekLabel(monday, today), views: [] };
				out.push(week);
			}
			week.views.push(view);
		}
		return out;
	});
</script>

{#each weeks as week (week.monday)}
	<section class="week" aria-labelledby="week-{week.monday}">
		<h2 class="label" id="week-{week.monday}">
			{week.label}<span>{week.views.length} gig{week.views.length === 1 ? '' : 's'}</span>
		</h2>
		<div class="rows">
			{#each week.views as view (view.id)}
				<GigRow {view} {showVenue} />
			{/each}
		</div>
	</section>
{/each}

<style>
	.week {
		display: flex;
		flex-direction: column;
		gap: 4px;
		content-visibility: auto;
		contain-intrinsic-size: auto 400px;
	}
	h2 {
		display: flex;
		justify-content: space-between;
		border-bottom: 1px solid var(--line);
		padding: 10px 0 6px;
	}
	h2 span {
		letter-spacing: 0.08em;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
</style>
