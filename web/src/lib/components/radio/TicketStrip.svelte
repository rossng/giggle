<!-- The gig as a ticket stub: date block, venue and room (and how the listener sorted it), who
     they open for when they're the support act (a big headliner explains a big price), when and
     how much, and links. -->
<script lang="ts">
	import { TRIAGE_LABELS, type Triage } from '$lib/board/board';
	import type { GigView } from '$lib/data/catalog';
	import { dayParts, relativeDays } from '$lib/data/dates';
	import { externalHref } from '$lib/data/slugs';
	import type { IsoDate } from '$lib/data/types';

	let {
		view,
		today,
		artistKey = null,
		youtubeMusic = null,
		mark = null
	}: {
		view: GigView;
		today: IsoDate;
		/** Whose ticket this is: when they're the support act, it says who they support. */
		artistKey?: string | null;
		youtubeMusic?: string | null;
		/** How the listener sorted it. */
		mark?: Triage | null;
	} = $props();

	const gig = $derived(view.gig);
	const day = $derived(dayParts(view.date));
	const where = $derived([view.venueName, gig.room].filter(Boolean).join(' · '));
	const status = $derived(
		gig.status === 'postponed'
			? 'Postponed'
			: gig.status === 'moved'
				? 'Moved'
				: gig.availability === 'few_left'
					? 'Few tickets left'
					: gig.availability === 'not_yet_on_sale'
						? 'Not on sale yet'
						: null
	);
	const meta = $derived(
		[
			day.weekday,
			view.time === '00:00' ? null : view.time,
			view.city !== 'amsterdam' ? view.cityName : null,
			view.soldOut ? null : view.price,
			relativeDays(view.date, today)
		].filter(Boolean)
	);
	const supporting = $derived.by(() => {
		if (gig.artists.find((a) => a.key === artistKey)?.role !== 'support') return null;
		const heads = gig.artists.filter((a) => a.role === 'headliner').map((a) => a.name);
		if (!heads.length) return null;
		return heads.slice(0, 2).join(' & ') + (heads.length > 2 ? ` +${heads.length - 2}` : '');
	});
	const tickets = $derived(externalHref(gig.ticket_url) ?? externalHref(gig.url));
</script>

<div class="ticket" class:sold={view.soldOut}>
	<div class="date" aria-label="{day.weekday} {day.day} {day.month}">
		<b>{day.day}</b><span>{day.month.toUpperCase()}</span>
	</div>
	<div class="body">
		<span class="venue"
			>{where}{#if mark}<span class="badge b-{mark}">{TRIAGE_LABELS[mark]}</span>{/if}</span
		>
		{#if supporting}<span class="supporting ellipsis">Supporting {supporting}</span>{/if}
		<span class="meta">
			{meta.join(' · ')}
			{#if view.soldOut}<span class="soldout"> · Sold out</span>{/if}
			{#if status}<span class="status"> · {status}</span>{/if}
		</span>
	</div>
	<div class="links">
		{#if tickets}<a href={tickets} target="_blank" rel="noopener noreferrer"
				>{view.soldOut ? 'Resale' : 'Tickets'} ↗</a
			>{/if}
		<a href={view.href}>Gig page</a>
		{#if externalHref(youtubeMusic)}<a
				href={externalHref(youtubeMusic)}
				target="_blank"
				rel="noopener noreferrer">YT Music ↗</a
			>{/if}
	</div>
</div>

<style>
	.ticket {
		display: flex;
		align-items: stretch;
		background: var(--p2);
		border-radius: 8px;
		overflow: hidden;
		max-width: 600px;
		/* Punched notches either side of the perforation. */
		-webkit-mask:
			radial-gradient(circle 6px at 64px 0, transparent 98%, #000) top / 100% 51% no-repeat,
			radial-gradient(circle 6px at 64px 100%, transparent 98%, #000) bottom / 100% 51% no-repeat;
		mask:
			radial-gradient(circle 6px at 64px 0, transparent 98%, #000) top / 100% 51% no-repeat,
			radial-gradient(circle 6px at 64px 100%, transparent 98%, #000) bottom / 100% 51% no-repeat;
	}
	.date {
		width: 64px;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		border-right: 1px dashed var(--line);
		padding: 8px 0;
	}
	.date b {
		font: 800 30px/0.9 var(--f-display);
		color: var(--amber);
	}
	.date span {
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.12em;
		color: var(--mute);
	}
	.body {
		padding: 9px 14px;
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		min-width: 0;
	}
	.venue {
		font-weight: 650;
		font-size: 15px;
	}
	.venue .badge {
		margin-left: 8px;
		vertical-align: 2px;
	}
	.supporting {
		font-size: 12.5px;
		color: var(--amber);
	}
	.meta {
		font-size: 12.5px;
		color: var(--mute);
		font-variant-numeric: tabular-nums;
	}
	.soldout {
		color: var(--bad);
		font-weight: 600;
	}
	.status {
		color: var(--amber);
	}
	.links {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
		padding: 8px 14px 8px 0;
		font-size: 12.5px;
		font-weight: 650;
		white-space: nowrap;
	}
	.links a {
		color: var(--amber);
		text-decoration: none;
	}
	.links a:hover {
		text-decoration: underline;
	}
	@media (max-width: 520px) {
		.ticket {
			flex-wrap: wrap;
		}
		.links {
			flex-direction: row;
			gap: 14px;
			width: 100%;
			padding: 8px 14px;
			border-top: 1px dashed var(--line);
		}
		.ticket {
			-webkit-mask: none;
			mask: none;
		}
	}
</style>
