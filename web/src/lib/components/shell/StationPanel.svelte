<!-- The station & settings drawer: which gigs the radio plays, in what order, and how the
     announcer sounds. Opened from the player bar or the Radio page; everything here is optional,
     so it stays out of the way until asked for. -->
<script lang="ts">
	import type { RadioOrder, VoiceMode } from '@giggle/radio-core';
	import FilterPanel from '$lib/components/FilterPanel.svelte';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';
	import { dateWindow, facetCounts, summarise, toQuery, type Filters } from '$lib/data/filters';
	import { filterNames, type Catalog } from '$lib/data/catalog';
	import { radioApp } from '$lib/radio/app.svelte';
	import { TRACKS_PER_ARTIST, type LiveVoice } from '$lib/radio/persist';
	import { pickVoice } from '$lib/radio/speaker';
	import { ORDER_DESCRIPTIONS, ORDER_LABELS } from '$lib/radio/station';

	let { catalog }: { catalog: Catalog } = $props();

	const now = new Date();
	const radio = $derived(radioApp.radio(catalog));
	const station = $derived(radioApp.station);
	const counts = $derived(facetCounts(station.filters, catalog.gigs, now, unavailableDates.test));
	const range = $derived(dateWindow(station.filters, now));
	const summary = $derived(summarise(station.filters, filterNames(catalog)));
	const voiceName = $derived(pickVoice(radio.voices, radio.settings.voiceName)?.name ?? '');

	function updateFilters(next: Partial<Filters>) {
		radioApp.station = { ...station, filters: { ...station.filters, ...next } };
	}

	let dialog: HTMLDialogElement | undefined = $state();
	$effect(() => {
		if (!dialog) return;
		if (radioApp.settingsOpen && !dialog.open) dialog.showModal();
		if (!radioApp.settingsOpen && dialog.open) dialog.close();
	});

	const ORDERS: RadioOrder[] = ['date', 'mix', 'shuffle'];
	const VOICE_MODES: { mode: VoiceMode; label: string }[] = [
		{ mode: 'off', label: 'Off' },
		{ mode: 'name', label: 'Names' },
		{ mode: 'short', label: 'Short intros' }
	];
	const LIVE_VOICES: { voice: LiveVoice; label: string }[] = [
		{ voice: 'kokoro', label: 'Kokoro' },
		{ voice: 'browser', label: 'Browser' }
	];
	const kokoroNote = $derived.by(() => {
		const k = radio.kokoro;
		if (radio.liveSlow) return 'Kokoro is too slow on this device: using the browser voice.';
		if (!k || k.status === 'off') return null;
		if (k.status === 'loading')
			return `Loading Kokoro${k.progress ? ` (${Math.round(k.progress * 100)}%)` : ''}…`;
		if (k.status === 'failed') return "Kokoro couldn't load: using the browser voice.";
		return null;
	});
</script>

<dialog
	bind:this={dialog}
	class="drawer"
	aria-label="Station and settings"
	onclose={() => (radioApp.settingsOpen = false)}
	onclick={(e) => e.target === dialog && dialog?.close()}
>
	<div class="inner">
		<header>
			<h2 class="display">Station</h2>
			<button type="button" class="close" onclick={() => dialog?.close()} aria-label="Close"
				>✕</button
			>
		</header>

		<section>
			<p class="summary">{summary}</p>
			<p class="stat">
				<b>{radio.queue.length}</b> artists{#if radio.skipped}
					· skipping <b>{radio.skipped}</b> not for me{/if}{#if radio.withoutTracks}
					· <b>{radio.withoutTracks}</b> without songs{/if}
			</p>
			<a class="link" href="/agenda{toQuery(station.filters)}" onclick={() => dialog?.close()}
				>See these gigs in the agenda →</a
			>
		</section>

		<section>
			<h3 class="label">Which gigs</h3>
			<FilterPanel filters={station.filters} {catalog} {counts} {range} onchange={updateFilters} />
		</section>

		<section>
			<h3 class="label">Order</h3>
			<div class="seg" role="group" aria-label="Order">
				{#each ORDERS as order (order)}
					<button
						type="button"
						class:on={radio.order === order}
						aria-pressed={radio.order === order}
						title={order !== 'date' && radio.order === order
							? 'Reshuffle'
							: ORDER_DESCRIPTIONS[order]}
						onclick={() => radio.setOrder(order)}
						>{ORDER_LABELS[
							order
						]}{#if order !== 'date' && radio.order === order}&thinsp;⟳{/if}</button
					>
				{/each}
			</div>
			<p class="hint">{ORDER_DESCRIPTIONS[radio.order]}.</p>
		</section>

		<section>
			<h3 class="label">Tracks per artist</h3>
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

		<section>
			<h3 class="label">Announcer</h3>
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
			<details class="more">
				<summary>Voice</summary>
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
					<p class="hint" role="status">{kokoroNote}</p>
				{/if}
				{#if radio.voices.length}
					<label class="pick">
						<span class="hint"
							>{radio.settings.liveVoice === 'kokoro' ? 'Fallback voice' : 'Browser voice'}</span
						>
						<select value={voiceName} onchange={(e) => radio.setVoiceName(e.currentTarget.value)}>
							{#each radio.voices as v (v.name)}
								<option value={v.name}>{v.name} ({v.lang})</option>
							{/each}
						</select>
					</label>
				{/if}
			</details>
		</section>

		<section class="kbd-hint">
			<h3 class="label">Keys</h3>
			<p class="keys">
				<kbd>space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> tracks · <kbd>N</kbd> next artist ·
				<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>X</kbd> sort the artist
			</p>
		</section>
	</div>
</dialog>

<style>
	.drawer {
		margin: 0 0 0 auto;
		height: 100dvh;
		max-height: none;
		width: min(400px, 100vw);
		padding: 0;
		border: 0;
		border-left: 1px solid var(--line);
		background: var(--p1);
		color: var(--ink);
	}
	.drawer::backdrop {
		background: rgb(0 0 0 / 0.5);
	}
	.inner {
		display: flex;
		flex-direction: column;
		gap: 22px;
		padding: 18px 18px 40px;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	h2 {
		margin: 0;
		font-size: 36px;
	}
	h3 {
		margin: 0 0 8px;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.close {
		border: 0;
		background: var(--p2);
		color: var(--ink);
		width: 32px;
		height: 32px;
		border-radius: 50%;
		cursor: pointer;
	}
	.summary {
		margin: 0;
		font-weight: 600;
	}
	.stat,
	.hint,
	.keys {
		margin: 0;
		color: var(--mute);
		font-size: 12.5px;
	}
	.stat b {
		color: var(--ink);
	}
	.keys {
		line-height: 2;
	}
	.link {
		color: var(--amber);
		font-size: 12.5px;
		text-decoration: none;
	}
	.seg {
		display: flex;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 3px;
	}
	@media (hover: none) and (pointer: coarse) {
		.kbd-hint {
			display: none;
		}
		.seg button {
			min-height: 44px;
		}
		.close {
			width: 44px;
			height: 44px;
		}
	}
	.seg button {
		flex: 1;
		border: 0;
		background: none;
		color: var(--mute);
		padding: 6px 4px;
		border-radius: 6px;
		font-size: 12.5px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}
	.seg button.on {
		background: var(--p3);
		color: var(--ink);
	}
	.more summary {
		cursor: pointer;
		color: var(--mute);
		font-size: 12.5px;
		margin: 6px 0;
	}
	.more {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.pick {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 8px;
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
</style>
