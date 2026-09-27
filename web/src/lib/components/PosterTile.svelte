<!--
	A square, flyer-like tile: the artist's name in condensed type over a halftone dot pattern
	in its genre's colour, or their Wikipedia photo tinted in that colour. Decorative: the
	name is always given in text nearby. `size` is its width in px; a parent can override it with
	the --poster-size CSS variable (say, smaller on phones), and the lettering scales with it.
-->
<script lang="ts">
	import { imageSrc } from '$lib/data/image-hosts';

	let {
		name,
		colour,
		thumb = null,
		size = 52
	}: { name: string; colour: string; thumb?: string | null; size?: number } = $props();

	let failed = $state(false);
	const src = $derived(imageSrc(thumb));

	const words = $derived(name.toUpperCase().split(/\s+/).filter(Boolean));

	/** The largest font size (px) at which the name roughly fits the tile. Condensed display
	 * type is a little under half an em wide per character. */
	const fontSize = $derived.by(() => {
		const inner = size * 0.84;
		const longest = Math.max(1, ...words.map((w) => w.length));
		const chars = words.join(' ').length;
		// The longest word must fit on its own line: wide letters (W, M) run past the average.
		let font = Math.min(size * 0.3, inner / (0.56 * longest));
		while (font > size * 0.11) {
			const lines = Math.max(words.length > 1 ? 2 : 1, Math.ceil((chars * 0.44 * font) / inner));
			if (lines * font * 0.9 <= inner) break;
			font *= 0.92;
		}
		return Math.max(font, size * 0.11);
	});
	/** The same, as a share of the tile's width, so it follows --poster-size. */
	const fontShare = $derived((fontSize / size) * 100);
</script>

<div class="poster" aria-hidden="true" style:--c={colour} style:--size="{size}px">
	{#if src && !failed}
		<img
			{src}
			alt=""
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
			onerror={() => (failed = true)}
		/>
	{:else}
		<span style:font-size="{fontShare.toFixed(2)}cqi">{words.join(' ')}</span>
	{/if}
</div>

<style>
	.poster {
		width: var(--poster-size, var(--size));
		height: var(--poster-size, var(--size));
		border-radius: 11%;
		container-type: inline-size;
		position: relative;
		overflow: hidden;
		flex: none;
		display: flex;
		align-items: flex-end;
		background-color: var(--c);
		background-image: radial-gradient(circle at 1px 1px, rgb(0 0 0 / 0.28) 1px, transparent 1.4px);
		background-size: 5px 5px;
	}
	span {
		font-family: var(--f-display);
		font-weight: 800;
		line-height: 0.88;
		letter-spacing: -0.01em;
		color: #15111c;
		overflow-wrap: anywhere;
		max-height: 100%;
		overflow: hidden;
		padding: 8cqi;
	}
	img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: grayscale(1) contrast(1.15);
		mix-blend-mode: multiply;
	}
</style>
