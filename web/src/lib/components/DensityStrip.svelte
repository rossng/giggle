<!--
	How many of the shown gigs fall on each day of the window. With filters on, each bar is split:
	the shown gigs, and above them the rest of that day's gigs. Pointing at a day highlights it
	and says its date and counts.
-->
<script lang="ts">
	import type { GigView } from '$lib/data/catalog';
	import { addDays, dayParts, daysBetween, formatDay } from '$lib/data/dates';
	import type { DateWindow } from '$lib/data/filters';
	import type { IsoDate } from '$lib/data/types';

	let {
		views,
		all = views,
		range
	}: {
		views: GigView[];
		/** Every gig in the window, filters or not. */
		all?: GigView[];
		range: DateWindow;
	} = $props();

	function perDay(list: GigView[]): Map<IsoDate, number> {
		const counts = new Map<IsoDate, number>();
		for (const v of list) counts.set(v.date, (counts.get(v.date) ?? 0) + 1);
		return counts;
	}

	const days = $derived.by(() => {
		const n = daysBetween(range.first, range.last) + 1;
		const shown = perDay(views);
		const total = perDay(all);
		return Array.from({ length: n }, (_, i) => {
			const date = addDays(range.first, i);
			const count = shown.get(date) ?? 0;
			return { date, count, total: Math.max(count, total.get(date) ?? 0) };
		});
	});
	const filtered = $derived(all.length > views.length);
	const max = $derived(Math.max(1, ...days.map((d) => d.total)));
	/** Month names where a month starts (and at the left edge). */
	const months = $derived(
		days
			.map((d, i) => ({ i, parts: dayParts(d.date) }))
			.filter(({ i, parts }) => i === 0 || parts.day === 1)
			.map(({ i, parts }) => ({ left: (i / days.length) * 100, label: parts.month }))
			.filter((m, i, all) => i === all.length - 1 || all[i + 1].left - m.left > 6)
	);
	const busiest = $derived(days.reduce((a, b) => (b.count > a.count ? b : a), days[0]));

	/** The day being pointed at, by index. */
	let hover = $state<number | null>(null);
	const hovered = $derived(hover === null ? undefined : days[hover]);
	let clearTimer: ReturnType<typeof setTimeout> | undefined;

	function point(e: PointerEvent) {
		clearTimeout(clearTimer);
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const i = Math.floor(((e.clientX - box.left) / box.width) * days.length);
		hover = Math.min(days.length - 1, Math.max(0, i));
	}
	// A touch leaves as the finger lifts, so its day stays up a moment to be read.
	function leave(e: PointerEvent) {
		clearTimeout(clearTimer);
		if (e.pointerType === 'mouse') hover = null;
		else clearTimer = setTimeout(() => (hover = null), 2500);
	}
	$effect(() => () => clearTimeout(clearTimer));

	const pct = (n: number) => `${(n / max) * 100}%`;
	const gigs = (n: number) => `${n} gig${n === 1 ? '' : 's'}`;
</script>

<figure class="density">
	<!-- Pointer only, like the bars: the list below says the same for everyone. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bars"
		class:filtered
		aria-hidden="true"
		onpointermove={point}
		onpointerdown={point}
		onpointerleave={leave}
		onpointercancel={leave}
	>
		{#each days as day, i (day.date)}
			<span class="day" class:on={hover === i} class:empty={day.total === 0}>
				{#if day.total === 0}
					<i class="stub"></i>
				{:else}
					{#if day.total > day.count}<i class="rest" style:height={pct(day.total - day.count)}
						></i>{/if}
					{#if day.count}<i class="shown" style:height={pct(day.count)}></i>{/if}
				{/if}
			</span>
		{/each}
	</div>
	<div class="months" aria-hidden="true">
		{#each months as m (m.left)}
			<span class="label" style:left="{m.left}%">{m.label}</span>
		{/each}
		{#if hovered && hover !== null}
			<span
				class="tip"
				style:left="{((hover + 0.5) / days.length) * 100}%"
				style:translate="{hover < days.length / 4
					? -10
					: hover >= (days.length * 3) / 4
						? -90
						: -50}%"
			>
				<b>{formatDay(hovered.date)}</b>
				{filtered && hovered.total
					? `${hovered.count} of ${gigs(hovered.total)}`
					: gigs(hovered.count)}
			</span>
		{/if}
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
		height: 30px;
		cursor: default;
	}
	/* Each day is a full-height column, so pointing anywhere above a bar finds it. */
	.day {
		flex: 1;
		min-width: 1px;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		padding: 0 1px;
	}
	.day i {
		display: block;
		flex: none;
	}
	.day i:first-child {
		border-radius: 2px 2px 0 0;
	}
	.shown {
		background: var(--p3);
	}
	/* With filters on, the shown gigs stand out from the rest of the day's. */
	.filtered .shown {
		background: color-mix(in srgb, var(--mute) 75%, var(--bg));
	}
	.rest {
		background: var(--p2);
	}
	.stub {
		height: 6%;
		background: var(--p3);
		opacity: 0.4;
	}
	.day.on .shown,
	.filtered .day.on .shown,
	.day.on .stub {
		background: var(--amber);
		opacity: 1;
	}
	.day.on .rest {
		background: color-mix(in srgb, var(--amber) 30%, var(--bg));
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
	/* Over the month names, at its day (leaning inwards near the ends, to stay in the strip). */
	.tip {
		z-index: 1;
		white-space: nowrap;
		font: 500 11px/1 var(--f-mono);
		color: var(--mute);
		background: var(--p2);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 4px 6px;
		margin-top: -3px;
	}
	.tip b {
		color: var(--ink);
		font-weight: 600;
		margin-right: 4px;
	}
</style>
