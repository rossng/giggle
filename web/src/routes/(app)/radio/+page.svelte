<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type {
		Artist as CoreArtist,
		Gig as CoreGig,
		RadioOrder,
		VoiceMode
	} from '@giggle/radio-core';
	import FilterPanel from '$lib/components/FilterPanel.svelte';
	import PosterTile from '$lib/components/PosterTile.svelte';
	import SiteNav from '$lib/components/SiteNav.svelte';
	import Wordmark from '$lib/components/Wordmark.svelte';
	import NowPlaying from '$lib/components/radio/NowPlaying.svelte';
	import UpNext from '$lib/components/radio/UpNext.svelte';
	import { TRIAGES, TRIAGE_KEYS, TRIAGE_LABELS, countByState, type Triage } from '$lib/board/board';
	import { amsterdamDate } from '$lib/data/dates';
	import {
		apply,
		dateWindow,
		facetCounts,
		summarise,
		toQuery,
		type Filters
	} from '$lib/data/filters';
	import { NO_GENRE_COLOUR } from '$lib/data/genres';
	import { TRACKS_PER_ARTIST, type LiveVoice } from '$lib/radio/persist';
	import { Radio } from '$lib/radio/radio.svelte';
	import { pickVoice } from '$lib/radio/speaker';
	import {
		ORDER_DESCRIPTIONS,
		ORDER_LABELS,
		stationFromParams,
		stationKey,
		stationQuery
	} from '$lib/radio/station';
	import { artistImage, squareImage, introClips, trackIndex } from '$lib/radio/tracks';

	let { data } = $props();
	const catalog = $derived(data.catalog);
	const artists = $derived(catalog.artists);

	// Read once per visit, like the agenda: the window is relative to today.
	const now = new Date();
	const today = amsterdamDate(now);

	const station = $derived(stationFromParams(page.url.searchParams));
	const shown = $derived(apply(station.filters, catalog.gigs, now));
	const tracks = $derived(trackIndex(artists));
	const clips = $derived(introClips(artists));
	const counts = $derived(facetCounts(station.filters, catalog.gigs, now));
	const range = $derived(dateWindow(station.filters, now));
	const summary = $derived(
		summarise(station.filters, {
			city: (key) => catalog.cities.find((c) => c.key === key)?.name ?? key,
			venue: (slug) => catalog.venues[slug]?.name ?? slug
		})
	);

	function go(query: string) {
		const target = `${page.url.pathname}${query}`;
		if (target === `${page.url.pathname}${page.url.search}`) return;
		goto(target, { replaceState: true, keepFocus: true, noScroll: true });
	}

	/** Filter changes replace the history entry (as on the agenda). */
	function updateFilters(next: Partial<Filters>) {
		go(stationQuery({ ...station, filters: { ...station.filters, ...next } }));
	}

	const radio = untrack(
		() =>
			new Radio({
				venues: catalog.venues,
				image: (entry) => artistImage(data.catalog.artists[entry.artistKey]),
				onOrderChange: (order: RadioOrder, seed: number) =>
					go(stationQuery({ filters: station.filters, order, seed }))
			})
	);

	$effect(() => {
		const input = {
			key: stationKey(station.filters),
			gigs: shown.map((v) => v.gig) as unknown as CoreGig[],
			tracks,
			artists: artists as unknown as Record<string, CoreArtist>,
			clips,
			order: station.order,
			orderGiven: station.orderGiven,
			seed: station.seed
		};
		untrack(() => radio.setStation(input));
	});

	let video: HTMLDivElement | undefined = $state();
	onMount(() => (video ? radio.attach(video) : undefined));

	const entry = $derived(radio.entry);
	const track = $derived(radio.track);
	const artist = $derived(entry ? artists[entry.artistKey] : undefined);
	const view = $derived(entry ? catalog.byId.get(entry.gig.id) : undefined);
	const triage = $derived(entry ? (radio.board[entry.artistKey]?.state ?? null) : null);
	const venueCount = $derived(new Set(radio.queue.map((e) => e.gig.venue)).size);
	const boardCounts = $derived(countByState(radio.board));
	const voiceName = $derived(pickVoice(radio.voices, radio.settings.voiceName)?.name ?? '');
	const shownTime = $derived(radio.resumeAt ?? radio.time);
	const progress = $derived(radio.duration ? Math.min(1, shownTime / radio.duration) : 0);
	const noTracksAtAll = $derived(tracks.size === 0);

	function clock(seconds: number): string {
		const s = Math.max(0, Math.floor(seconds || 0));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	const VOICE_MODES: { mode: VoiceMode; label: string }[] = [
		{ mode: 'off', label: 'Off' },
		{ mode: 'name', label: 'Name' },
		{ mode: 'short', label: 'Short' }
	];
	const LIVE_VOICES: { voice: LiveVoice; label: string }[] = [
		{ voice: 'kokoro', label: 'Kokoro' },
		{ voice: 'browser', label: 'Browser voice' }
	];
	/** How in-browser Kokoro is doing, when there's something to say about it. */
	const kokoroNote = $derived.by(() => {
		const k = radio.kokoro;
		if (radio.liveSlow) return 'Kokoro is too slow on this device: using the browser voice.';
		if (!k || k.status === 'off') return null;
		if (k.status === 'loading')
			return `Loading Kokoro${k.progress ? ` (${Math.round(k.progress * 100)}%)` : ''}…`;
		if (k.status === 'failed') return "Kokoro couldn't load: using the browser voice.";
		return null;
	});
	const ORDERS: RadioOrder[] = ['date', 'mix', 'shuffle'];

	function onkeydown(event: KeyboardEvent) {
		if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
		const target = event.target as HTMLElement | null;
		if (
			target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
		) {
			return;
		}
		const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
		const triageKey = TRIAGES.find((t) => TRIAGE_KEYS[t].toLowerCase() === key);
		const actions: Record<string, () => void> = {
			' ': () => radio.togglePlay(),
			ArrowRight: () => radio.next(),
			ArrowLeft: () => radio.previous(),
			n: () => radio.nextArtist()
		};
		const action = triageKey ? () => radio.triage(triageKey) : actions[key];
		if (!action) return;
		event.preventDefault();
		action();
	}

	function seek(event: MouseEvent) {
		const bar = event.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		radio.seekTo(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
	}

	const title = $derived(entry ? `${entry.name} · Radio · giggle` : 'Radio · giggle');
</script>

<svelte:head><title>{title}</title></svelte:head>

<svelte:window {onkeydown} onpagehide={() => radio.save()} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'hidden' && radio.save()} />

<div class="radio">
	<aside class="side" aria-label="Station">
		<div class="brand">
			<Wordmark />
			<SiteNav query={toQuery(station.filters)} />
		</div>

		<section class="block">
			<h2 class="label">Station</h2>
			<p class="station">{summary}</p>
			<p class="stat">
				<b>{radio.queue.length}</b> artists · <b>{venueCount}</b> venue{venueCount === 1 ? '' : 's'}
			</p>
			{#if radio.skipped}<p class="stat">Skipping <b>{radio.skipped}</b> not for me</p>{/if}
			{#if radio.withoutTracks}<p class="stat">
					<b>{radio.withoutTracks}</b> without songs on YouTube Music
				</p>{/if}
			<details class="change">
				<summary>Change station</summary>
				<FilterPanel
					filters={station.filters}
					{catalog}
					{counts}
					{range}
					onchange={updateFilters}
				/>
			</details>
			<a class="stat link" href="/agenda{toQuery(station.filters)}"
				>See these gigs in the agenda →</a
			>
		</section>

		<section class="block">
			<h2 class="label">Order</h2>
			<div class="seg" role="group" aria-label="Order">
				{#each ORDERS as order (order)}
					<button
						type="button"
						class:on={radio.order === order}
						aria-pressed={radio.order === order}
						title={order === 'date'
							? ORDER_DESCRIPTIONS.date
							: radio.order === order
								? 'Reshuffle'
								: ORDER_DESCRIPTIONS[order]}
						onclick={() => radio.setOrder(order)}
						>{ORDER_LABELS[order]}{#if order !== 'date'}&thinsp;⟳{/if}</button
					>
				{/each}
			</div>
			<p class="hint">{ORDER_DESCRIPTIONS[radio.order]}.</p>
		</section>

		<section class="block">
			<h2 class="label">Tracks per artist</h2>
			<div class="seg" role="group" aria-label="Tracks per artist">
				{#each TRACKS_PER_ARTIST as n (n)}
					<button
						type="button"
						class:on={radio.settings.tracksPerArtist === n}
						aria-pressed={radio.settings.tracksPerArtist === n}
						onclick={() => radio.setTracksPerArtist(n)}>{n}</button
					>
				{/each}
			</div>
		</section>

		<section class="block">
			<h2 class="label">Announcer</h2>
			<div class="seg" role="group" aria-label="Announcer">
				{#each VOICE_MODES as { mode, label } (mode)}
					<button
						type="button"
						class:on={radio.settings.voiceMode === mode}
						aria-pressed={radio.settings.voiceMode === mode}
						onclick={() => radio.setVoiceMode(mode)}>{label}</button
					>
				{/each}
			</div>
			<div class="seg" role="group" aria-label="Live voice">
				{#each LIVE_VOICES as { voice, label } (voice)}
					<button
						type="button"
						class:on={radio.settings.liveVoice === voice}
						aria-pressed={radio.settings.liveVoice === voice}
						onclick={() => radio.setLiveVoice(voice)}>{label}</button
					>
				{/each}
			</div>
			{#if radio.settings.liveVoice === 'kokoro' && kokoroNote}
				<p class="stat voice-note" role="status">{kokoroNote}</p>
			{/if}
			{#if radio.voices.length}
				<label class="voice-pick">
					<span class="visually-hidden"
						>{radio.settings.liveVoice === 'kokoro' ? 'Fallback voice' : 'Voice'}</span
					>
					<select value={voiceName} onchange={(e) => radio.setVoiceName(e.currentTarget.value)}>
						{#each radio.voices as v (v.name)}
							<option value={v.name}>{v.name} ({v.lang})</option>
						{/each}
					</select>
				</label>
			{/if}
		</section>

		{#if boardCounts.listen + boardCounts.go + boardCounts.tickets}
			<p class="stat board">
				<a href="/board">Board</a>:
				{(['listen', 'go', 'tickets'] as Triage[])
					.filter((t) => boardCounts[t])
					.map((t) => `${boardCounts[t]} ${TRIAGE_LABELS[t].toLowerCase()}`)
					.join(' · ')}
			</p>
		{/if}
	</aside>

	<main class="stage">
		{#if radio.notice}<p class="notice" role="status">{radio.notice}</p>{/if}

		{#if entry && track}
			<NowPlaying
				{entry}
				{track}
				trackIndex={radio.position.trackIndex}
				{artist}
				{view}
				{today}
				{triage}
			/>
		{:else}
			<section class="empty">
				<h1 class="display">Nothing to play</h1>
				{#if noTracksAtAll}
					<p>
						No songs found for any artist yet: the data has no YouTube Music matches. Run the
						pipeline.
					</p>
				{:else}
					<p>
						None of the artists on this station have songs on YouTube Music. Try a wider station.
					</p>
				{/if}
				<a class="button" href="/radio">All gigs</a>
			</section>
		{/if}

		<div class="deck" class:hidden={!entry}>
			<div class="video" bind:this={video} aria-label="YouTube player"></div>
			<div class="deck-side">
				{#if entry && !radio.started}
					<div class="cue">
						{#if radio.resumeAt !== null && track}
							<p>
								Paused at <b>{clock(radio.resumeAt)}</b> into “{track.title}” by {entry.name}.
							</p>
							<button type="button" class="big" onclick={() => radio.start()}>
								▶ Resume <kbd>space</kbd>
							</button>
						{:else}
							<p>
								{radio.queue.length} artists with gigs coming up, {ORDER_DESCRIPTIONS[radio.order]}.
							</p>
							<button type="button" class="big" onclick={() => radio.start()}>
								▶ Start listening <kbd>space</kbd>
							</button>
						{/if}
					</div>
				{:else if radio.caption && radio.settings.voiceMode !== 'off'}
					<div class="voice" class:speaking={radio.speaking} aria-live="polite">
						<span class="voice-icon" aria-hidden="true">
							<svg viewBox="0 0 20 20" width="17" height="17"
								><path d="M3 8v4h3l4 3.5V4.5L6 8H3z" fill="currentColor" /><path
									d="M13 7a4 4 0 0 1 0 6M15.5 5a7 7 0 0 1 0 10"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
								/></svg
							>
						</span>
						<p>
							<span class="label">Announcer{radio.speaking ? ' · on air' : ''}</span>
							“{radio.caption.text}”
						</p>
					</div>
				{/if}

				<div class="sortbar" role="group" aria-label="Sort this artist">
					<span class="label">Sort this artist</span>
					{#each TRIAGES as t (t)}
						<button
							type="button"
							class="sort s-{t}"
							class:on={triage === t}
							aria-pressed={triage === t}
							disabled={!entry}
							onclick={() => radio.triage(t)}><kbd>{TRIAGE_KEYS[t]}</kbd>{TRIAGE_LABELS[t]}</button
						>
					{/each}
				</div>
			</div>
		</div>
	</main>

	<aside class="upnext" aria-label="Up next">
		<div class="upnext-head">
			<h2 class="label">Up next</h2>
			<span class="label">{radio.queue.length}</span>
		</div>
		<UpNext
			queue={radio.queue}
			current={radio.position.artistIndex}
			started={radio.started}
			board={radio.board}
			{catalog}
			{artists}
			onjump={(i) => radio.jump(i)}
		/>
		<p class="note">
			Order: {ORDER_LABELS[radio.order]} · {radio.settings.tracksPerArtist}
			track{radio.settings.tracksPerArtist === 1 ? '' : 's'} each
		</p>
	</aside>

	<footer class="player" aria-label="Player">
		<div class="mini">
			{#if entry}
				{#key entry.artistKey}
					<PosterTile
						name={entry.name}
						colour={view?.colour ?? NO_GENRE_COLOUR}
						thumb={squareImage(artistImage(artist), 96)}
						size={36}
					/>
				{/key}
				<div>
					<b>{track?.title}</b>
					<span>{entry.name}</span>
				</div>
			{/if}
		</div>
		<div class="controls">
			<div class="buttons">
				<button
					type="button"
					class="icon"
					title="Previous track (←)"
					onclick={() => radio.previous()}
				>
					<svg viewBox="0 0 20 20" aria-hidden="true"
						><path d="M5 4v12" stroke="currentColor" stroke-width="1.8" /><path
							d="M16 4 7 10l9 6z"
							fill="currentColor"
						/></svg
					><span class="visually-hidden">Previous track</span>
				</button>
				<button
					type="button"
					class="play"
					title="{radio.on ? 'Pause' : 'Play'} (space)"
					onclick={() => radio.togglePlay()}
					disabled={!entry}
				>
					{#if radio.on}
						<svg viewBox="0 0 20 20" aria-hidden="true"
							><rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor" /><rect
								x="11.5"
								y="4"
								width="3.5"
								height="12"
								rx="1"
								fill="currentColor"
							/></svg
						><span class="visually-hidden">Pause</span>
					{:else}
						<svg viewBox="0 0 20 20" aria-hidden="true"
							><path d="M6 3.5v13L16.5 10z" fill="currentColor" /></svg
						><span class="visually-hidden">Play</span>
					{/if}
				</button>
				<button type="button" class="icon" title="Next track (→)" onclick={() => radio.next()}>
					<svg viewBox="0 0 20 20" aria-hidden="true"
						><path d="M15 4v12" stroke="currentColor" stroke-width="1.8" /><path
							d="M4 4l9 6-9 6z"
							fill="currentColor"
						/></svg
					><span class="visually-hidden">Next track</span>
				</button>
				<button type="button" class="skip" onclick={() => radio.nextArtist()}
					>Next artist <kbd>N</kbd></button
				>
			</div>
			<div class="progress">
				<span>{clock(shownTime)}</span>
				<button
					type="button"
					class="bar"
					aria-label="Seek"
					onclick={seek}
					disabled={!radio.duration}
				>
					<i style:width="{progress * 100}%"></i>
				</button>
				<span>{clock(radio.duration)}</span>
			</div>
		</div>
		<div class="right">
			<span class="source">via YouTube Music</span>
			<span class="keys"
				><kbd>space</kbd> <kbd>←</kbd><kbd>→</kbd> <kbd>N</kbd> <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd
				><kbd>X</kbd></span
			>
		</div>
	</footer>
</div>

<style>
	.radio {
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr) 280px;
		grid-template-rows: minmax(0, 1fr) auto;
		height: 100vh;
		height: 100dvh;
	}
	.side,
	.upnext {
		background: var(--p1);
		min-height: 0;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.side {
		border-right: 1px solid var(--line);
		padding: 18px 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}
	.brand {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.brand :global(nav) {
		margin-left: -9px;
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.station {
		font-weight: 650;
		font-size: 14px;
		line-height: 1.35;
	}
	.stat {
		font-size: 12px;
		color: var(--mute);
	}
	.stat b {
		color: var(--ink);
	}
	.link {
		color: var(--amber);
		text-decoration: none;
	}
	.link:hover {
		text-decoration: underline;
	}
	.hint {
		font-size: 11.5px;
		color: var(--mute);
	}
	.change summary {
		cursor: pointer;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--amber);
	}
	.change[open] summary {
		margin-bottom: 14px;
	}
	.seg {
		display: flex;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 2px;
		gap: 2px;
	}
	.seg button {
		flex: 1;
		border: 0;
		background: none;
		padding: 5px 6px;
		border-radius: 6px;
		color: var(--mute);
		font-size: 12px;
		cursor: pointer;
		white-space: nowrap;
	}
	.seg button.on {
		background: var(--p3);
		color: var(--ink);
		font-weight: 600;
	}
	.seg + .seg {
		margin-top: 8px;
	}
	.voice-note {
		margin: 6px 0 0;
	}
	select {
		width: 100%;
		font-size: 12px;
		background: var(--bg);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 5px 6px;
	}
	.board a {
		color: var(--ink);
	}

	.stage {
		min-height: 0;
		overflow-y: auto;
		padding: 20px 26px 28px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}
	.notice {
		font-size: 12.5px;
		color: var(--mute);
		border-left: 2px solid var(--amber);
		padding-left: 10px;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		color: var(--mute);
		max-width: 60ch;
	}
	.empty h1 {
		font-size: 48px;
		color: var(--ink);
	}
	.deck {
		display: grid;
		grid-template-columns: 356px minmax(0, 1fr);
		gap: 22px;
		align-items: start;
	}
	.deck.hidden {
		/* Kept in the DOM for the player, but nothing to show. */
		position: absolute;
		left: -10000px;
	}
	/* YouTube's terms: the embed stays visible and at least 200 × 200 px. */
	.video {
		width: 356px;
		aspect-ratio: 16 / 9;
		min-height: 200px;
		border-radius: 8px;
		overflow: hidden;
		background: #000;
	}
	.video :global(iframe) {
		width: 100%;
		height: 100%;
		display: block;
		border: 0;
	}
	.deck-side {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}
	.cue,
	.voice {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		border: 1px solid rgb(255 181 71 / 0.28);
		background: linear-gradient(90deg, rgb(255 181 71 / 0.1), transparent 70%);
		border-radius: 10px;
		padding: 12px 14px;
	}
	.cue {
		flex-direction: column;
	}
	.cue p {
		color: var(--mute);
	}
	.cue b {
		color: var(--ink);
	}
	.big {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 9px 16px;
		border-radius: 999px;
		border: 0;
		background: var(--amber);
		color: var(--bg);
		font-weight: 700;
		font-size: 14px;
		cursor: pointer;
	}
	.big kbd {
		background: rgb(0 0 0 / 0.14);
		border-color: transparent;
		color: var(--bg);
	}
	.voice p {
		font-size: 14px;
		line-height: 1.5;
	}
	.voice .label {
		display: block;
		color: var(--amber);
		margin-bottom: 5px;
	}
	.voice-icon {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--amber);
		color: var(--bg);
		display: grid;
		place-items: center;
		flex: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		.speaking .voice-icon {
			animation: pulse 1.6s ease-in-out infinite;
		}
	}
	@keyframes pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgb(255 181 71 / 0.45);
		}
		50% {
			box-shadow: 0 0 0 7px rgb(255 181 71 / 0);
		}
	}
	.sortbar {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.sortbar .label {
		margin-right: 4px;
	}
	.sort {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 7px 11px;
		border-radius: 8px;
		background: var(--p2);
		border: 1px solid transparent;
		font-weight: 600;
		font-size: 12.5px;
		white-space: nowrap;
		cursor: pointer;
	}
	.sort:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.sort.s-nope {
		background: transparent;
		border-color: var(--line);
		color: var(--mute);
	}
	.sort.on {
		background: var(--amber);
		color: var(--bg);
	}
	.sort.on kbd {
		background: rgb(0 0 0 / 0.14);
		border-color: transparent;
		color: var(--bg);
	}

	.upnext {
		border-left: 1px solid var(--line);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.upnext-head {
		padding: 18px 16px 10px;
		display: flex;
		justify-content: space-between;
	}
	.note {
		padding: 10px 16px 14px;
		font-size: 11px;
		color: var(--mute);
		border-top: 1px solid var(--line);
	}

	.player {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr) 280px;
		align-items: center;
		gap: 16px;
		padding: 10px 16px;
		background: #0f0c14;
		border-top: 1px solid var(--line);
	}
	.mini {
		display: flex;
		gap: 10px;
		align-items: center;
		min-width: 0;
	}
	.mini div {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.mini b,
	.mini span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mini b {
		font-size: 13px;
	}
	.mini span {
		font-size: 11.5px;
		color: var(--mute);
	}
	.controls {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: center;
		min-width: 0;
	}
	.buttons {
		display: flex;
		gap: 16px;
		align-items: center;
	}
	.icon,
	.play,
	.skip,
	.bar {
		border: 0;
		cursor: pointer;
	}
	.icon {
		background: none;
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: 50%;
	}
	.icon svg {
		width: 16px;
		height: 16px;
	}
	.icon:hover {
		background: var(--p2);
	}
	.play {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: var(--ink);
		color: var(--bg);
		display: grid;
		place-items: center;
	}
	.play svg {
		width: 16px;
		height: 16px;
	}
	.play:disabled {
		opacity: 0.4;
	}
	.skip {
		font-size: 11.5px;
		color: var(--mute);
		background: none;
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 3px 5px 3px 10px;
		display: inline-flex;
		gap: 6px;
		align-items: center;
	}
	.skip:hover {
		color: var(--ink);
	}
	.progress {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		max-width: 480px;
		font: 500 11px var(--f-mono);
		color: var(--mute);
		font-variant-numeric: tabular-nums;
	}
	.bar {
		flex: 1;
		height: 14px;
		padding: 5px 0;
		background: none;
		display: block;
	}
	.bar::before {
		content: '';
		display: block;
		height: 4px;
		background: var(--p3);
		border-radius: 2px;
	}
	.bar i {
		display: block;
		height: 4px;
		margin-top: -4px;
		background: var(--amber);
		border-radius: 2px;
	}
	.bar:disabled {
		cursor: default;
	}
	.right {
		justify-self: end;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
	}
	.source {
		font-size: 11px;
		color: #ff5c6f;
		border: 1px solid rgb(255 51 77 / 0.45);
		border-radius: 999px;
		padding: 3px 9px;
	}
	.keys {
		display: flex;
		gap: 3px;
	}

	/* Narrower screens: queue under the stage, settings after it. */
	@media (max-width: 1100px) {
		.radio {
			grid-template-columns: 220px minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr) auto;
		}
		.upnext {
			display: none;
		}
		.player {
			grid-template-columns: 220px minmax(0, 1fr) auto;
		}
		.keys {
			display: none;
		}
	}
	@media (max-width: 1100px) and (min-width: 861px) {
		.deck {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* Phones: one column, the page scrolls, the player sticks to the bottom. */
	@media (max-width: 860px) {
		.radio {
			display: flex;
			flex-direction: column;
			height: auto;
			min-height: 100vh;
		}
		.stage,
		.upnext {
			overflow: visible;
		}
		/* The side panel's parts go around the stage: station first, settings last. */
		.side {
			display: contents;
		}
		.brand,
		.block {
			background: var(--p1);
			padding: 12px 16px;
		}
		.brand {
			order: 0;
			padding-bottom: 0;
		}
		.block:first-of-type {
			order: 0;
			border-bottom: 1px solid var(--line);
		}
		.block,
		.side > .board {
			order: 3;
		}
		.side > .board {
			padding: 0 16px 16px;
			background: var(--p1);
		}
		.stage {
			order: 1;
			padding: 16px;
		}
		.upnext {
			order: 2;
			display: flex;
			border-left: 0;
			border-top: 1px solid var(--line);
			border-bottom: 1px solid var(--line);
			max-height: 420px;
		}
		.player {
			order: 9;
			position: sticky;
			bottom: 0;
			z-index: 5;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 8px 12px;
			padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
		}
		.right {
			display: none;
		}
		.controls {
			align-items: flex-end;
		}
		.buttons {
			gap: 8px;
		}
		.progress {
			grid-column: 1 / -1;
			max-width: none;
		}
		.deck {
			grid-template-columns: minmax(0, 1fr);
		}
		.video {
			width: 100%;
		}
	}
	@media (max-width: 480px) {
		.skip kbd {
			display: none;
		}
		.player {
			grid-template-columns: minmax(0, 1fr);
		}
		.controls {
			align-items: center;
		}
	}
</style>
