<!-- How many of the shown gigs fall on each day of the window. -->
<script lang="ts">
	import type { GigView } from '$lib/data/catalog';
	import { addDays, dayParts, daysBetween, formatDay, weekStart } from '$lib/data/dates';
	import type { DateWindow } from '$lib/data/filters';
	import type { IsoDate } from '$lib/data/types';

	let { views, range, today }: { views: GigView[]; range: DateWindow; today: IsoDate } = $props();

	const days = $derived.by(() => {
		const n = daysBetween(range.first, range.last) + 1;
		const counts = new Map<IsoDate, number>();
		for (const v of views) counts.set(v.date, (counts.get(v.date) ?? 0) + 1);
		const nextMonday = addDays(weekStart(today), 7);
		return Array.from({ length: n }, (_, i) => {
			const date = addDays(range.first, i);
			return { date, count: counts.get(date) ?? 0, thisWeek: date < nextMonday };
		});
	});
	const max = $derived(Math.max(1, ...days.map((d) => d.count)));
	/** Month names where a month starts (and at the left edge). */
	const months = $derived(
		days
			.map((d, i) => ({ i, parts: dayParts(d.date) }))
			.filter(({ i, parts }) => i === 0 || parts.day === 1)
			.map(({ i, parts }) => ({ left: (i / days.length) * 100, label: parts.month }))
			.filter((m, i, all) => i === all.length - 1 || all[i + 1].left - m.left > 6)
	);
	const busiest = $derived(days.reduce((a, b) => (b.count > a.count ? b : a), days[0]));
</script>

<figure class="density">
	<div class="bars" aria-hidden="true">
		{#each days as day (day.date)}
			<i
				class:week={day.thisWeek}
				class:empty={day.count === 0}
				style:height="{Math.max(day.count / max, 0.06) * 100}%"
				title="{formatDay(day.date)}: {day.count} gig{day.count === 1 ? '' : 's'}"
			></i>
		{/each}
	</div>
	<div class="months" aria-hidden="true">
		{#each months as m (m.left)}
			<span class="label" style:left="{m.left}%">{m.label}</span>
		{/each}
	</div>
	{#if busiest}
		<figcaption class="visually-hidden">
			Gigs per day. Busiest: {formatDay(busiest.date)}, with {busiest.count}.
		</figcaption>
	{/if}
</figure>

<style>
	.density {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 30px;
	}
	.bars i {
		flex: 1;
		min-width: 1px;
		background: var(--p3);
		border-radius: 2px 2px 0 0;
	}
	.bars i.week {
		background: var(--amber);
	}
	.bars i.empty {
		opacity: 0.4;
	}
	.months {
		position: relative;
		height: 12px;
	}
	.months span {
		position: absolute;
		top: 0;
		letter-spacing: 0.1em;
	}
</style>
