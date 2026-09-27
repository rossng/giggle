<script lang="ts">
	// The radio's own page: the video, who's on and their gig, sorting them, and what's next. The
	// radio itself (and its player bar and settings) lives in the app layout (lib/radio/app), so
	// it keeps playing on other pages; this page's URL mirrors the station, so it can be shared.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import NowPlaying from '$lib/components/radio/NowPlaying.svelte';
	import UpNext from '$lib/components/radio/UpNext.svelte';
	import { TRIAGES, TRIAGE_KEYS, TRIAGE_LABELS } from '$lib/board/board';
	import { amsterdamDate } from '$lib/data/dates';
	import { summarise } from '$lib/data/filters';
	import { filterNames } from '$lib/data/catalog';
	import { radioApp } from '$lib/radio/app.svelte';
	import { ORDER_LABELS, stationFromParams, stationQuery } from '$lib/radio/station';

	let { data } = $props();
	const catalog = $derived(data.catalog);
	const artists = $derived(catalog.artists);
	const radio = $derived(radioApp.radio(catalog));
	const today = amsterdamDate(new Date());

	function replaceUrl(query: string) {
		goto(`/radio${query}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// The URL names a station: tune to it. A bare /radio keeps the current station (and shows it).
	$effect(() => {
		const search = page.url.search;
		untrack(() => {
			const current = stationQuery(radioApp.station);
			if (search === '' && current !== '') replaceUrl(current);
			else if (search !== current) radioApp.station = stationFromParams(page.url.searchParams);
		});
	});
	// And the other way: a station changed here (settings, reshuffle) shows in the URL.
	$effect(() => {
		const query = stationQuery(radioApp.station);
		untrack(() => {
			if (page.url.pathname === '/radio' && query !== page.url.search) replaceUrl(query);
		});
	});

	// The video dock sits over this slot while the page is open.
	let slot: HTMLDivElement | undefined = $state();
	$effect(() => {
		radioApp.videoSlot = slot ?? null;
		return () => (radioApp.videoSlot = null);
	});

	const entry = $derived(radio.entry);
	const track = $derived(radio.track);
	const artist = $derived(entry ? artists[entry.artistKey] : undefined);
	const view = $derived(entry ? catalog.byId.get(entry.gig.id) : undefined);
	const triage = $derived(entry ? (radio.board[entry.artistKey]?.state ?? null) : null);
	const summary = $derived(summarise(radioApp.station.filters, filterNames(catalog)));
	let queueOpen = $state(false);

	const title = $derived(entry ? `${entry.name} · Radio · giggle` : 'Radio · giggle');
</script>

<svelte:head><title>{title}</title></svelte:head>

<div class="radio">
	<main class="now">
		{#if radio.notice}<p class="notice" role="status">{radio.notice}</p>{/if}

		<div class="video" class:empty={!entry} bind:this={slot}></div>

		{#if entry && track}
			<NowPlaying
				{entry}
				{track}
				trackIndex={radio.position.trackIndex}
				{artist}
				{view}
				{today}
				{triage}
			>
				{#snippet actions()}
					<div class="sort" role="group" aria-label="Sort this artist">
						{#each TRIAGES as t (t)}
							<button
								type="button"
								class="s-{t}"
								class:on={triage === t}
								aria-pressed={triage === t}
								onclick={() => radio.triage(t)}
								><kbd>{TRIAGE_KEYS[t]}</kbd><span>{TRIAGE_LABELS[t]}</span></button
							>
						{/each}
					</div>
					{#if radio.caption && radio.settings.voiceMode !== 'off' && radio.started}
						<p class="caption" class:speaking={radio.speaking} aria-live="polite">
							<span class="label">{radio.speaking ? 'On air' : 'Announcer'}</span>
							“{radio.caption.text}”
						</p>
					{/if}
				{/snippet}
			</NowPlaying>
		{:else}
			<section class="nothing">
				<h1 class="display">Nothing to play</h1>
				<p>None of the artists on this station have songs on YouTube Music. Try a wider station.</p>
				<button type="button" class="button" onclick={() => (radioApp.settingsOpen = true)}
					>Change station</button
				>
			</section>
		{/if}
	</main>

	<aside class="upnext" class:open={queueOpen} aria-label="Up next">
		<div class="head">
			<button
				type="button"
				class="toggle"
				aria-expanded={queueOpen}
				onclick={() => (queueOpen = !queueOpen)}
			>
				<span class="label">Up next</span>
				<span class="count">{radio.queue.length}</span>
			</button>
			<button
				type="button"
				class="station"
				title="Change the station"
				onclick={() => (radioApp.settingsOpen = true)}
			>
				<span>{summary}</span>
				<span class="order"
					>{ORDER_LABELS[radio.order]} · {radio.settings.tracksPerArtist}
					track{radio.settings.tracksPerArtist === 1 ? '' : 's'} each</span
				>
			</button>
		</div>
		<div class="list">
			<UpNext
				queue={radio.queue}
				current={radio.position.artistIndex}
				started={radio.started}
				board={radio.board}
				{catalog}
				{artists}
				onjump={(i) => radio.jump(i)}
			/>
		</div>
	</aside>
</div>

<style>
	.radio {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 300px;
		min-height: calc(100dvh - var(--top-h) - var(--player-h) - var(--tabs-h));
	}
	.now {
		width: 100%;
		max-width: 760px;
		margin: 0 auto;
		padding: 24px 24px 40px;
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}
	.notice {
		margin: 0;
		padding: 8px 12px;
		border-radius: 8px;
		background: var(--p2);
		color: var(--mute);
		font-size: 13px;
	}
	/* The video dock (lib/components/shell/VideoDock) is positioned over this. */
	.video {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 12px;
		background: #000;
	}
	.video.empty {
		display: none;
	}
	.sort {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
	}
	.sort button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-width: 0;
		padding: 10px 8px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--p1);
		color: var(--ink);
		font-weight: 600;
		font-size: 13.5px;
		cursor: pointer;
	}
	.sort button span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sort button:hover {
		border-color: var(--mute);
	}
	.sort .s-nope {
		color: var(--mute);
	}
	.sort button.on {
		border-color: transparent;
		color: var(--bg);
	}
	.sort .s-listen.on {
		background: #8ea3ff;
	}
	.sort .s-go.on {
		background: var(--amber);
	}
	.sort .s-tickets.on {
		background: #7fd1a0;
	}
	.sort .s-nope.on {
		background: var(--mute);
	}
	.sort button.on kbd {
		background: rgb(0 0 0 / 0.15);
		color: inherit;
		border-color: transparent;
	}
	.caption {
		margin: 0;
		font-size: 13px;
		color: var(--mute);
	}
	.caption .label {
		margin-right: 6px;
	}
	.caption.speaking .label {
		color: var(--amber);
	}
	.nothing {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		padding: 40px 0;
	}
	.nothing h1 {
		margin: 0;
		font-size: 48px;
	}
	.nothing p {
		margin: 0;
		color: var(--mute);
	}
	.upnext {
		position: sticky;
		top: var(--top-h);
		align-self: start;
		height: calc(100dvh - var(--top-h) - var(--player-h) - var(--tabs-h));
		display: flex;
		flex-direction: column;
		background: var(--p1);
		border-left: 1px solid var(--line);
	}
	.head {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px 14px 10px;
		border-bottom: 1px solid var(--line);
	}
	.toggle {
		all: unset;
		display: flex;
		justify-content: space-between;
		pointer-events: none;
	}
	.count {
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	.station {
		all: unset;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--bg);
		border: 1px solid var(--line);
		font-size: 13px;
		font-weight: 600;
	}
	.station:hover {
		border-color: var(--mute);
	}
	.order {
		font-size: 11.5px;
		font-weight: 400;
		color: var(--mute);
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-width: thin;
	}

	@media (max-width: 1000px) {
		.radio {
			grid-template-columns: minmax(0, 1fr);
		}
		.upnext {
			position: static;
			height: auto;
			border-left: 0;
			border-top: 1px solid var(--line);
		}
		.toggle {
			pointer-events: auto;
			cursor: pointer;
		}
		.toggle .label::after {
			content: ' ▾';
		}
		.upnext.open .toggle .label::after {
			content: ' ▴';
		}
		.list {
			display: none;
			max-height: 60vh;
		}
		.upnext.open .list {
			display: block;
		}
	}
	@media (max-width: 700px) {
		.now {
			padding: 12px 12px 28px;
			gap: 14px;
		}
		.sort {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	/* Touch: big, easy targets (key badges are hidden on touch app-wide). */
	@media (hover: none) and (pointer: coarse) {
		.sort button {
			min-height: 48px;
			font-size: 14.5px;
		}
		.station {
			min-height: 44px;
		}
	}
</style>
