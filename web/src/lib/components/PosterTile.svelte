<!--
	A square, flyer-like tile: the artist's name in condensed type over a halftone dot pattern
	in its genre's colour, or their Wikipedia photo tinted in that colour. Decorative: the
	name is always given in text nearby.
-->
<script lang="ts">
	let {
		name,
		colour,
		thumb = null,
		size = 52
	}: { name: string; colour: string; thumb?: string | null; size?: number } = $props();

	let failed = $state(false);

	const words = $derived(name.toUpperCase().split(/\s+/).filter(Boolean));

	/** The largest font size (px) at which the name roughly fits the tile. Condensed display
	 * type is a little under half an em wide per character. */
	const fontSize = $derived.by(() => {
		const inner = size * 0.84;
		const longest = Math.max(1, ...words.map((w) => w.length));
		const chars = words.join(' ').length;
		let font = Math.min(size * 0.3, inner / (0.44 * longest));
		while (font > size * 0.11) {
			const lines = Math.max(words.length > 1 ? 2 : 1, Math.ceil((chars * 0.44 * font) / inner));
			if (lines * font * 0.9 <= inner) break;
			font *= 0.92;
		}
		return Math.max(font, size * 0.11);
	});
</script>

<div
	class="poster"
	aria-hidden="true"
	style:--c={colour}
	style:width="{size}px"
	style:height="{size}px"
	style:border-radius="{Math.round(size / 9)}px"
>
	{#if thumb && !failed}
		<img
			src={thumb}
			alt=""
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
			onerror={() => (failed = true)}
		/>
	{:else}
		<span style:font-size="{fontSize}px" style:padding="{size * 0.08}px">{words.join(' ')}</span>
	{/if}
</div>

<style>
	.poster {
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
