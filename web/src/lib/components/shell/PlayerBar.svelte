<!-- The radio's controls on every page: who's on (tap for the Radio page), play and skip, the
     position, sorting the artist, and the station & settings drawer. Phones keep the essentials. -->
<script lang="ts">
	import PosterTile from '$lib/components/PosterTile.svelte';
	import { TRIAGES, TRIAGE_KEYS, TRIAGE_LABELS } from '$lib/board/board';
	import type { Catalog } from '$lib/data/catalog';
	import { formatDay } from '$lib/data/dates';
	import { NO_GENRE_COLOUR } from '$lib/data/genres';
	import { radioApp } from '$lib/radio/app.svelte';
	import { stationQuery } from '$lib/radio/station';
	import { artistImage, squareImage } from '$lib/radio/tracks';

	let { catalog }: { catalog: Catalog } = $props();

	const radio = $derived(radioApp.radio(catalog));
	const entry = $derived(radio.entry);
	const track = $derived(radio.track);
	const artist = $derived(entry ? catalog.artists[entry.artistKey] : undefined);
	const view = $derived(entry ? catalog.byId.get(entry.gig.id) : undefined);
	const triage = $derived(entry ? (radio.board[entry.artistKey]?.state ?? null) : null);
	const shownTime = $derived(radio.resumeAt ?? radio.time);
	const progress = $derived(radio.duration ? Math.min(1, shownTime / radio.duration) : 0);
	const radioHref = $derived(`/radio${stationQuery(radioApp.station)}`);
	const gigLine = $derived(
		entry && view ? `${formatDay(entry.gig.start.slice(0, 10))} · ${view.venueName}` : ''
	);

	function clock(seconds: number): string {
		const s = Math.max(0, Math.floor(seconds || 0));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	function seek(event: MouseEvent) {
		const bar = event.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		radio.seekTo(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
	}
</script>

<footer class="player" aria-label="Player">
	<div class="line" aria-hidden="true"><i style:width="{progress * 100}%"></i></div>

	<a class="now" href={radioHref} title="Open the radio">
		{#if entry}
			{#key entry.artistKey}
				<PosterTile
					name={entry.name}
					colour={view?.colour ?? NO_GENRE_COLOUR}
					thumb={squareImage(artistImage(artist), 96)}
					size={44}
				/>
			{/key}
			<span class="text">
				<b>{entry.name}</b>
				<span class="sub">{track?.title ?? ''}</span>
				<span class="sub gig">{gigLine}</span>
			</span>
		{:else}
			<span class="text"><b>giggle radio</b><span class="sub">Gigs coming up, as radio</span></span>
		{/if}
	</a>

	<div class="controls">
		<div class="buttons">
			<div class="before">
				<button
					type="button"
					class="icon wide"
					title="Previous track (←)"
					onclick={() => radio.previous()}
					disabled={!radio.started}
				>
					<svg viewBox="0 0 20 20" aria-hidden="true"
						><path d="M5 4v12" stroke="currentColor" stroke-width="1.8" /><path
							d="M16 4 7 10l9 6z"
							fill="currentColor"
						/></svg
					><span class="visually-hidden">Previous track</span>
				</button>
			</div>
			<button
				type="button"
				class="play"
				title="{radio.on ? 'Pause' : radio.started ? 'Play' : 'Start listening'} (space)"
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
			<div class="after">
				<button
					type="button"
					class="icon"
					title="Next track (→)"
					onclick={() => radio.next()}
					disabled={!entry}
				>
					<svg viewBox="0 0 20 20" aria-hidden="true"
						><path d="M15 4v12" stroke="currentColor" stroke-width="1.8" /><path
							d="M4 4l9 6-9 6z"
							fill="currentColor"
						/></svg
					><span class="visually-hidden">Next track</span>
				</button>
				<button
					type="button"
					class="skip wide"
					onclick={() => radio.nextArtist()}
					disabled={!entry}
					title="Next artist (N)">Next artist</button
				>
			</div>
		</div>
		<div class="progress wide">
			<span>{clock(shownTime)}</span>
			<button type="button" class="bar" aria-label="Seek" onclick={seek} disabled={!radio.duration}>
				<i style:width="{progress * 100}%"></i>
			</button>
			<span>{clock(radio.duration)}</span>
		</div>
	</div>

	<div class="right wide">
		<div class="sort" role="group" aria-label="Sort this artist">
			{#each TRIAGES as t (t)}
				<button
					type="button"
					class="s-{t}"
					class:on={triage === t}
					aria-pressed={triage === t}
					disabled={!entry}
					title="{TRIAGE_LABELS[t]} ({TRIAGE_KEYS[t]})"
					onclick={() => radio.triage(t)}
					>{TRIAGE_KEYS[t]}<span class="visually-hidden"> {TRIAGE_LABELS[t]}</span></button
				>
			{/each}
		</div>
		<button
			type="button"
			class="icon"
			title="Station & settings"
			aria-haspopup="dialog"
			onclick={() => (radioApp.settingsOpen = true)}
		>
			<svg viewBox="0 0 20 20" aria-hidden="true"
				><path
					d="M3 6h9M15 6h2M3 14h2M8 14h9"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/><circle
					cx="13.5"
					cy="6"
					r="1.8"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				/><circle
					cx="6.5"
					cy="14"
					r="1.8"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				/></svg
			><span class="visually-hidden">Station & settings</span>
		</button>
	</div>
</footer>

<style>
	.player {
		position: fixed;
		left: 0;
		right: 0;
		bottom: var(--tabs-h);
		z-index: 40;
		height: var(--player-h);
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 16px;
		padding: 0 16px;
		background: #0f0c14;
		border-top: 1px solid var(--line);
	}
	.line {
		display: none;
	}
	.now {
		display: flex;
		gap: 10px;
		align-items: center;
		min-width: 0;
		color: inherit;
		text-decoration: none;
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.3;
	}
	.text b,
	.sub {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.text b {
		font-size: 13.5px;
	}
	.sub {
		font-size: 12px;
		color: var(--mute);
	}
	.gig {
		color: var(--amber);
	}
	.controls {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: stretch;
		padding-top: 4px;
	}
	/* Play sits in the middle, over the progress bar; the rest goes either side of it. */
	.buttons {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 14px;
	}
	.before,
	.after {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.before {
		justify-content: flex-end;
	}
	button {
		border: 0;
		cursor: pointer;
		color: inherit;
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.icon {
		background: none;
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: 50%;
	}
	.icon svg {
		width: 17px;
		height: 17px;
	}
	.icon:hover:not(:disabled) {
		background: var(--p2);
	}
	.play {
		width: 40px;
		height: 40px;
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
	.skip {
		font-size: 12px;
		color: var(--mute);
		background: none;
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 4px 11px;
		white-space: nowrap;
	}
	.skip:hover:not(:disabled) {
		color: var(--ink);
	}
	.progress {
		align-self: center;
		display: flex;
		align-items: center;
		gap: 10px;
		width: min(420px, 36vw);
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
	.bar i,
	.line i {
		display: block;
		height: 4px;
		margin-top: -4px;
		background: var(--amber);
		border-radius: 2px;
	}
	.right {
		justify-self: end;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.sort {
		display: flex;
		gap: 4px;
	}
	.sort button {
		width: 30px;
		height: 28px;
		border-radius: 7px;
		background: var(--p2);
		color: var(--mute);
		font: 600 12px var(--f-mono);
	}
	.sort button:hover:not(:disabled) {
		color: var(--ink);
	}
	.sort button.on {
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

	/* Phones: who's on, play and next; the rest is on the Radio page. */
	@media (max-width: 700px) {
		.player {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 8px;
			padding: 0 10px 0 12px;
		}
		.wide {
			display: none;
		}
		.line {
			display: block;
			position: absolute;
			left: 0;
			right: 0;
			top: -1px;
			height: 2px;
			background: var(--p3);
		}
		.line i {
			height: 2px;
			margin: 0;
			border-radius: 0;
		}
		.gig {
			display: none;
		}
		.buttons {
			gap: 6px;
		}
		.controls {
			gap: 0;
		}
	}
	@media (hover: none) and (pointer: coarse) {
		.icon {
			width: 44px;
			height: 44px;
		}
		.play {
			width: 46px;
			height: 46px;
		}
	}
</style>
