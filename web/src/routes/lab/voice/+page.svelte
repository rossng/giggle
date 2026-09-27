<script lang="ts">
	// Lab: Kokoro in the browser. How long the model takes to load, how fast lines render
	// (the radio needs well under real time), and how a live line compares with the
	// pipeline's pre-rendered clip of the same text.
	import { onDestroy } from 'svelte';
	import { ANNOUNCERS } from '$lib/voice/announcers';
	import { KokoroVoice, type KokoroState, type Rendered } from '$lib/voice/kokoro';
	import { fileSize, MODEL_FILES } from '$lib/voice/model-source';
	import { DTYPES, type Device, type Dtype } from '$lib/voice/protocol';

	const SAMPLES = [
		'They play Paradiso tomorrow night.',
		"Staying with Nobu: this is 'Tidewater'.",
		'That was Tidewater, by Mike.',
		'Catch them at Tolhuistuin on Friday the 3rd of October. Tickets are about 24 euros.',
		"It's sold out, sadly, so keep an eye out for resale.",
		'You’re listening to giggle. Up next, a band from Leiden who play Nobel on Saturday.'
	];

	let device: Device | 'auto' = $state('auto');
	let dtype: Dtype | 'auto' = $state('auto');
	let voiceName: string = $state(ANNOUNCERS[0]);
	let text = $state(SAMPLES[0]!);
	let kokoro: KokoroVoice | null = null;
	let ks: KokoroState | null = $state(null);
	let last: Rendered | null = $state.raw(null);
	let busy = $state(false);
	let bench: string | null = $state(null);
	let clip: { url: string; text: string; voice: string } | null = $state(null);
	let unsubscribe = () => {};
	const abort = new AbortController();

	function start() {
		kokoro?.stop();
		unsubscribe();
		kokoro = new KokoroVoice({ device, dtype });
		unsubscribe = kokoro.subscribe((s) => (ks = s));
		kokoro.unlock();
		void kokoro.load().catch(() => {});
	}

	async function say(line = text, voice = voiceName) {
		if (!kokoro) start();
		kokoro!.unlock();
		busy = true;
		try {
			last = await kokoro!.render(line, voice);
			await kokoro!.play(last, abort.signal);
		} finally {
			busy = false;
		}
	}

	async function benchmark() {
		if (!kokoro) start();
		busy = true;
		bench = null;
		let ms = 0;
		let seconds = 0;
		try {
			for (const line of SAMPLES) {
				// A fresh voice/text pair each time, so nothing comes from the cache.
				const r = await kokoro!.render(
					`${line} `,
					voiceName === ANNOUNCERS[0] ? ANNOUNCERS[1] : ANNOUNCERS[0]
				);
				ms += r.ms;
				seconds += r.seconds;
			}
			bench = `${SAMPLES.length} lines: ${(ms / 1000).toFixed(1)} s to render ${seconds.toFixed(1)} s of speech (${(ms / 1000 / seconds).toFixed(2)}× real time)`;
		} finally {
			busy = false;
		}
	}

	async function loadClip() {
		const res = await fetch('/data/artists.json');
		const { artists } = (await res.json()) as {
			artists: Record<string, { announce?: { text: string; clip: string; voice: string }[] }>;
		};
		const withClips = Object.values(artists).filter((a) => a.announce?.length);
		const pick = withClips[Math.floor(Math.random() * withClips.length)]?.announce?.[0];
		if (pick) clip = { url: `/data/${pick.clip}`, text: pick.text, voice: pick.voice };
	}

	function playClip() {
		if (clip) void new Audio(clip.url).play();
	}

	onDestroy(() => {
		abort.abort();
		kokoro?.stop();
		unsubscribe();
	});

	const pct = (x: number) => `${Math.round(x * 100)}%`;
	const megabytes = (d: Dtype) => Math.round(fileSize(MODEL_FILES.dtypes[d]) / 1e6);
</script>

<svelte:head><title>Voice lab · giggle</title></svelte:head>

<main>
	<h1>Voice lab</h1>
	<p class="mute">Kokoro-82M running in this browser tab, for the radio's live lines.</p>

	<section>
		<h2>Model</h2>
		<div class="row">
			<label
				>Device <select bind:value={device}>
					<option value="auto">auto (WebGPU if available)</option>
					<option value="webgpu">webgpu</option>
					<option value="wasm">wasm (CPU)</option>
				</select></label
			>
			<label
				>Precision <select bind:value={dtype}>
					<option value="auto">auto (fp32 on GPU, q8 on CPU)</option>
					{#each DTYPES as d (d)}
						<option value={d}>{d} ({megabytes(d)} MB)</option>
					{/each}
				</select></label
			>
			<button onclick={start}>{ks ? 'Reload' : 'Load'}</button>
		</div>
		{#if ks}
			<p>
				<b>{ks.status}</b>
				{#if ks.status === 'loading'}· downloading {pct(ks.progress)}{/if}
				{#if ks.device}· {ks.device} {ks.dtype}{/if}
				{#if ks.loadMs !== null}· ready in {(ks.loadMs / 1000).toFixed(1)} s{/if}
				{#if ks.error}<span class="bad">· {ks.error}</span>{/if}
			</p>
		{/if}
	</section>

	<section>
		<h2>Say something</h2>
		<textarea rows="3" bind:value={text}></textarea>
		<div class="row">
			<select bind:value={text}>
				{#each SAMPLES as s (s)}<option value={s}>{s}</option>{/each}
			</select>
			<select bind:value={voiceName}>
				{#each ANNOUNCERS as v (v)}<option value={v}>{v}</option>{/each}
			</select>
			<button disabled={busy} onclick={() => say()}>Say</button>
			<button disabled={busy} onclick={benchmark}>Benchmark</button>
		</div>
		{#if last}
			<p>
				{last.ms ? `${(last.ms / 1000).toFixed(2)} s` : 'cached'} for {last.seconds.toFixed(1)} s of speech{#if last.ms}
					({(last.ms / 1000 / last.seconds).toFixed(2)}× real time){/if}
			</p>
			<p class="mono">{last.phonemes}</p>
		{/if}
		{#if bench}<p><b>{bench}</b></p>{/if}
	</section>

	<section>
		<h2>Compare with a pipeline clip</h2>
		<div class="row">
			<button onclick={loadClip}>Pick a random clip</button>
			{#if clip}
				<button onclick={playClip}>Play pipeline clip</button>
				<button disabled={busy} onclick={() => clip && say(clip.text, clip.voice)}
					>Say it live</button
				>
			{/if}
		</div>
		{#if clip}<p>“{clip.text}” <span class="mute">({clip.voice})</span></p>{/if}
	</section>

	{#if ks?.recent.length}
		<section>
			<h2>Recent</h2>
			<table>
				<tbody>
					{#each ks.recent as r, i (i)}
						<tr>
							<td>{(r.ms / 1000).toFixed(2)} s</td>
							<td>{r.seconds.toFixed(1)} s</td>
							<td>{(r.ms / 1000 / r.seconds).toFixed(2)}×</td>
							<td>{r.text}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 48rem;
		margin: 2rem auto;
		padding: 0 16px;
	}
	section {
		margin: 1.5rem 0;
		padding: 1rem;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.1rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	select,
	textarea {
		max-width: 100%;
	}
	textarea {
		width: 100%;
		margin-bottom: 0.5rem;
	}
	.mute {
		color: var(--mute);
	}
	.bad {
		color: var(--bad);
	}
	.mono {
		font-family: var(--f-mono);
		font-size: 0.85rem;
		color: var(--mute);
		overflow-wrap: anywhere;
	}
	td {
		padding: 0.15rem 0.5rem 0.15rem 0;
		vertical-align: top;
	}
</style>
