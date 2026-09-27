<!-- Long text (a venue's blurb, a bio) cut to a few lines, with "Read more" when there's more. -->
<script lang="ts">
	let { text, lines = 4 }: { text: string; lines?: number } = $props();

	let open = $state(false);
	let long = $state(false);
	let el: HTMLParagraphElement | undefined = $state();

	// Only offer "Read more" when the clamp actually cuts something off (it depends on the width).
	$effect(() => {
		if (!el || open) return;
		void text;
		const measure = () => (long = !!el && el.scrollHeight > el.clientHeight + 2);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	});
</script>

<div class="read">
	<p bind:this={el} class:clamped={!open} style:--lines={lines}>{text}</p>
	{#if long || open}
		<button type="button" class="toggle" aria-expanded={open} onclick={() => (open = !open)}
			>{open ? 'Show less' : 'Read more'}</button
		>
	{/if}
</div>

<style>
	.read {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		max-width: 68ch;
	}
	p {
		font-size: 14.5px;
		line-height: 1.6;
		white-space: pre-line;
		overflow-wrap: break-word;
	}
	.clamped {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: var(--lines);
		line-clamp: var(--lines);
		overflow: hidden;
	}
	.toggle {
		background: none;
		border: 0;
		padding: 8px 0;
		color: var(--amber);
		font-weight: 600;
		font-size: 13px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.toggle {
			min-height: 44px;
		}
	}
</style>
