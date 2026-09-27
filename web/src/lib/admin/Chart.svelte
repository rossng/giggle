<!-- One series over time, drawn as SVG at the width it gets: bars (counts per day or week) or a
     line with a soft fill (a level per day). Hover, tap or arrow keys show a point's value; the
     numbers are also in a table under "Numbers". -->
<script lang="ts">
	import More from '$lib/components/pages/More.svelte';
	import { niceMax, shortDate, ticks, type Point } from './stats';

	let {
		points,
		kind = 'bars',
		label,
		unit,
		/** How a point's day reads in the tooltip ("3 Oct", "week of 28 Sep"). */
		when = (day: string) => shortDate(day)
	}: {
		points: Point[];
		kind?: 'bars' | 'line';
		label: string;
		unit: [one: string, many: string];
		when?: (day: string) => string;
	} = $props();

	const HEIGHT = 160;
	const PAD = { top: 10, right: 6, bottom: 22, left: 30 };

	let width = $state(0);
	let active: number | null = $state(null);

	const top = $derived(niceMax(Math.max(0, ...points.map((p) => p.value))));
	const plotW = $derived(Math.max(0, width - PAD.left - PAD.right));
	const plotH = HEIGHT - PAD.top - PAD.bottom;
	const step = $derived(points.length ? plotW / points.length : 0);
	const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
	const x = (i: number) => PAD.left + i * step;
	const mid = (i: number) => x(i) + step / 2;

	/** A bar from the baseline with 4px rounded top corners (less when thin). */
	function bar(i: number, value: number): string {
		const gap = step > 6 ? 2 : 1;
		const w = Math.max(1, step - gap);
		const left = x(i) + gap / 2;
		const h = Math.max(value > 0 ? 2 : 0, (value / top) * plotH);
		const r = Math.min(4, w / 2, h);
		const base = PAD.top + plotH;
		return `M${left},${base} V${base - h + r} Q${left},${base - h} ${left + r},${base - h} H${left + w - r} Q${left + w},${base - h} ${left + w},${base - h + r} V${base} Z`;
	}

	const line = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${mid(i)},${y(p.value)}`).join(' '));
	const area = $derived(
		points.length
			? `${line} L${mid(points.length - 1)},${PAD.top + plotH} L${mid(0)},${PAD.top + plotH} Z`
			: ''
	);

	/** Labels along the bottom: about one per 70px, on the points' own days. */
	const xLabels = $derived.by(() => {
		if (!points.length || !plotW) return [];
		const every = Math.max(1, Math.ceil(70 / step));
		const out: { i: number; text: string }[] = [];
		for (let i = points.length - 1; i >= 0; i -= every)
			out.push({ i, text: shortDate(points[i]!.day) });
		return out;
	});

	/** Bottom labels near an edge grow inwards, so they aren't cut off. */
	const anchor = (at: number) =>
		at > width - PAD.right - 28 ? 'end' : at < PAD.left + 28 ? 'start' : 'middle';

	const count = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? unit[0] : unit[1]}`;

	function pick(event: PointerEvent) {
		const svg = event.currentTarget as SVGSVGElement;
		const at = event.clientX - svg.getBoundingClientRect().left - PAD.left;
		const i = Math.floor(at / step);
		active = i >= 0 && i < points.length ? i : null;
	}

	function onkeydown(event: KeyboardEvent) {
		const last = points.length - 1;
		const moves: Record<string, number> = {
			ArrowLeft: Math.max(0, (active ?? last + 1) - 1),
			ArrowRight: Math.min(last, (active ?? -1) + 1),
			Home: 0,
			End: last
		};
		if (!(event.key in moves) || last < 0) return;
		event.preventDefault();
		active = moves[event.key]!;
	}

	const summary = $derived(
		points.length
			? `${label}: ${points.length} points from ${when(points[0]!.day)} to ${when(points.at(-1)!.day)}, highest ${count(Math.max(...points.map((p) => p.value)))}.`
			: `${label}: no data.`
	);
</script>

<figure class="chart">
	<div class="plot" bind:clientWidth={width}>
		{#if width}
			<!-- A chart you can explore with the keyboard. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<svg
				{width}
				height={HEIGHT}
				role="img"
				aria-label={summary}
				tabindex="0"
				onpointermove={pick}
				onpointerdown={pick}
				onpointerleave={(e) => e.pointerType === 'mouse' && (active = null)}
				onblur={() => (active = null)}
				{onkeydown}
			>
				{#each ticks(top) as t (t)}
					<line
						class="grid"
						class:base={t === 0}
						x1={PAD.left}
						x2={width - PAD.right}
						y1={y(t)}
						y2={y(t)}
					/>
					<text class="axis" x={PAD.left - 6} y={y(t)} dy="0.32em" text-anchor="end">
						{t.toLocaleString('en-GB')}
					</text>
				{/each}
				{#each xLabels as l (l.i)}
					<text class="axis" x={mid(l.i)} y={HEIGHT - 6} text-anchor={anchor(mid(l.i))}
						>{l.text}</text
					>
				{/each}
				{#if kind === 'bars'}
					{#each points as p, i (p.day)}
						{#if p.value > 0}
							<path class="bar" class:dim={active !== null && active !== i} d={bar(i, p.value)} />
						{/if}
					{/each}
				{:else}
					<path class="area" d={area} />
					<path class="line" d={line} />
				{/if}
				{#if active !== null && points[active]}
					<line class="cross" x1={mid(active)} x2={mid(active)} y1={PAD.top} y2={PAD.top + plotH} />
					{#if kind === 'line'}
						<circle class="dot" cx={mid(active)} cy={y(points[active].value)} r="4" />
					{/if}
				{/if}
			</svg>
			{#if active !== null && points[active]}
				{@const p = points[active]}
				<div
					class="tip"
					role="status"
					style:left="{Math.min(Math.max(mid(active), 60), width - 60)}px"
					style:top="{Math.max(0, y(p.value) - 8)}px"
				>
					<strong>{count(p.value)}</strong>
					<span>{when(p.day)}</span>
				</div>
			{/if}
		{/if}
	</div>
	<More label="Numbers">
		<table class="numbers">
			<thead><tr><th scope="col">Day</th><th scope="col">{unit[1]}</th></tr></thead>
			<tbody>
				{#each [...points].reverse() as p (p.day)}
					<tr><td>{when(p.day)}</td><td>{p.value.toLocaleString('en-GB')}</td></tr>
				{/each}
			</tbody>
		</table>
	</More>
</figure>

<style>
	.chart {
		margin: 0;
		min-width: 0;
	}
	.plot {
		position: relative;
		height: 160px;
	}
	svg {
		display: block;
		touch-action: pan-y;
		cursor: crosshair;
	}
	svg:focus-visible {
		outline: 2px solid var(--amber);
		outline-offset: 2px;
	}
	.grid {
		stroke: var(--line);
		stroke-width: 1;
	}
	.grid.base {
		stroke: var(--mute);
		stroke-opacity: 0.5;
	}
	.axis {
		fill: var(--mute);
		font: 500 10px var(--f-mono);
	}
	.bar {
		fill: var(--amber);
		transition: opacity 0.1s;
	}
	.bar.dim {
		opacity: 0.45;
	}
	.line {
		fill: none;
		stroke: var(--amber);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.area {
		fill: var(--amber);
		fill-opacity: 0.12;
	}
	.cross {
		stroke: var(--mute);
		stroke-dasharray: 2 3;
	}
	.dot {
		fill: var(--amber);
		stroke: var(--bg);
		stroke-width: 2;
	}
	.tip {
		position: absolute;
		transform: translate(-50%, -100%);
		pointer-events: none;
		background: var(--p3);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 5px 9px;
		display: flex;
		flex-direction: column;
		white-space: nowrap;
		font-size: 12px;
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.35);
	}
	.tip span {
		color: var(--mute);
		font-size: 11.5px;
	}
	.numbers {
		border-collapse: collapse;
		font-size: 12.5px;
		font-variant-numeric: tabular-nums;
	}
	.numbers th,
	.numbers td {
		padding: 3px 16px 3px 0;
		text-align: left;
	}
	.numbers th {
		color: var(--mute);
		font-weight: 600;
		text-transform: capitalize;
	}
	.numbers td + td {
		text-align: right;
	}
</style>
