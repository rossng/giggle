<!-- The app's one YouTube player. An iframe reloads if it moves in the page, so it never does:
     it stays in this fixed box, which sits exactly over the Radio page's video slot while that
     page is open and floats as a tile above the player bar elsewhere. YouTube requires the
     player to stay visible and at least 200×200 px while it plays, so the tile never shrinks
     below that, and tucking it away (phones) pauses. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { Catalog } from '$lib/data/catalog';
	import { radioApp } from '$lib/radio/app.svelte';
	import { ORDER_DESCRIPTIONS } from '$lib/radio/station';

	let { catalog }: { catalog: Catalog } = $props();

	const radio = $derived(radioApp.radio(catalog));
	let host: HTMLDivElement | undefined = $state();
	let rect: { top: number; left: number; width: number; height: number } | null = $state(null);

	onMount(() => (host ? radio.attach(host) : undefined));

	// Follow the Radio page's slot: its size (layout changes) and position (scrolling).
	$effect(() => {
		const slot = radioApp.videoSlot;
		if (!slot) {
			rect = null;
			return;
		}
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const r = slot.getBoundingClientRect();
				rect = { top: r.top, left: r.left, width: r.width, height: r.height };
			});
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(slot);
		addEventListener('scroll', update, { capture: true, passive: true });
		addEventListener('resize', update);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			removeEventListener('scroll', update, { capture: true });
			removeEventListener('resize', update);
		};
	});

	const docked = $derived(rect !== null);
	// Away from the Radio page the tile only shows while the radio has something on.
	const floating = $derived(!docked && radio.started && !!radio.entry);
	const tucked = $derived(floating && radioApp.videoTucked);

	function tuck() {
		radioApp.videoTucked = true;
		radio.pause();
	}
	function untuck() {
		radioApp.videoTucked = false;
	}
</script>

<div
	class="dock"
	class:docked
	class:floating
	class:tucked
	class:away={!docked && !floating}
	style:top={rect ? `${rect.top}px` : null}
	style:left={rect ? `${rect.left}px` : null}
	style:width={rect ? `${rect.width}px` : null}
	style:height={rect ? `${rect.height}px` : null}
	aria-label="YouTube player"
>
	<div class="host" bind:this={host}></div>

	{#if docked && radio.entry && !radio.started}
		<div class="cue">
			{#if radio.resumeAt !== null}
				<button type="button" class="start" onclick={() => radio.start()}>▶ Resume</button>
				<p>Paused where you left off.</p>
			{:else}
				<button type="button" class="start" onclick={() => radio.start()}>▶ Start listening</button>
				<p>
					{radio.queue.length} artists with gigs coming up, {ORDER_DESCRIPTIONS[radio.order]}.
				</p>
			{/if}
		</div>
	{/if}

	{#if floating}
		<button type="button" class="tuck" title="Hide the video (pauses)" onclick={tuck}>
			<svg viewBox="0 0 20 20" aria-hidden="true"
				><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" /></svg
			><span class="visually-hidden">Hide the video (pauses)</span>
		</button>
	{/if}
</div>

{#if tucked}
	<button type="button" class="untuck" onclick={untuck}>Show video</button>
{/if}

<style>
	.dock {
		position: fixed;
		z-index: 35;
		background: #000;
		border-radius: 12px;
		overflow: hidden;
	}
	.host,
	.host :global(iframe) {
		width: 100%;
		height: 100%;
		display: block;
		border: 0;
	}
	/* Elsewhere: a 16:9 tile above the player bar (never under YouTube's 200px minimum). */
	.floating {
		right: 16px;
		bottom: calc(var(--tabs-h) + var(--player-h) + 12px);
		width: 356px;
		height: 200px;
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.55);
		border: 1px solid var(--line);
	}
	/* Not playing and not on the Radio page: out of sight (nothing plays, so nothing to show). */
	.away,
	.tucked {
		left: -10000px;
		top: 0;
		width: 356px;
		height: 200px;
		visibility: hidden;
	}
	.cue {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 16px;
		text-align: center;
		background: rgb(15 12 20 / 0.72);
		backdrop-filter: blur(3px);
	}
	.cue p {
		margin: 0;
		max-width: 36ch;
		color: var(--mute);
		font-size: 13px;
	}
	.start {
		border: 0;
		border-radius: 999px;
		padding: 12px 22px;
		background: var(--amber);
		color: var(--bg);
		font-weight: 700;
		font-size: 15px;
		cursor: pointer;
	}
	.tuck {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 50%;
		background: rgb(0 0 0 / 0.6);
		color: #fff;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.tuck svg {
		width: 16px;
		height: 16px;
	}
	.untuck {
		position: fixed;
		right: 16px;
		bottom: calc(var(--tabs-h) + var(--player-h) + 10px);
		z-index: 35;
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 6px 12px;
		background: var(--p1);
		color: var(--mute);
		font-size: 12px;
		cursor: pointer;
	}
	@media (max-width: 700px) {
		.floating {
			right: 12px;
			width: min(356px, calc(100vw - 24px));
		}
	}
	@media (hover: none) and (pointer: coarse) {
		.tuck {
			width: 40px;
			height: 40px;
		}
		.untuck {
			padding: 12px 16px;
			font-size: 13px;
		}
	}
</style>
