<!-- What giggle is and who made it, from the top bar's "About". -->
<script lang="ts">
	let { open = $bindable(false) }: { open?: boolean } = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let sealReady = $state(false);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.showModal();
			// The seal is a web component (WebGL): only loaded when someone opens About.
			if (!sealReady)
				void import('seal-of-slop').then(
					() => (sealReady = true),
					() => {}
				);
		}
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	class="about"
	aria-labelledby="about-title"
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && dialog?.close()}
>
	<div class="inner">
		<header>
			<h2 id="about-title" class="display">About giggle</h2>
			<button type="button" class="close" onclick={() => dialog?.close()} aria-label="Close"
				>✕</button
			>
		</header>
		<p>
			Gigs coming up in and around Amsterdam, and a radio that plays the artists, so you can hear
			who's worth a ticket.
		</p>
		<p>
			Built by <a href="https://www.rossng.eu" target="_blank" rel="noopener">Ross Gardiner</a>. The
			code is on
			<a href="https://github.com/rossng/giggle" target="_blank" rel="noopener">GitHub</a>.
		</p>
		<p class="small">
			Gig listings come from the venues' own sites; artist details from MusicBrainz, Last.fm and
			Wikipedia; the music from YouTube.
		</p>
		<div class="seal">
			{#if sealReady}
				<seal-of-slop
					size="96"
					design="seal"
					text="Built with Claude Code: I directed and tested it; most of the code is AI-written. A personal project, shared as is."
				></seal-of-slop>
			{/if}
			<a class="small" href="https://www.rossng.eu/seal-of-slop/" target="_blank" rel="noopener"
				>About the seal</a
			>
		</div>
	</div>
</dialog>

<style>
	.about {
		width: min(440px, calc(100vw - 32px));
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--p1);
		color: var(--ink);
	}
	.about::backdrop {
		background: rgb(0 0 0 / 0.5);
	}
	.inner {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 20px 20px;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	h2 {
		margin: 0;
		font-size: 32px;
	}
	p {
		margin: 0;
		line-height: 1.5;
	}
	a {
		color: var(--amber);
	}
	.small {
		font-size: 12.5px;
		color: var(--mute);
	}
	.seal {
		display: flex;
		align-items: center;
		gap: 14px;
		min-height: 96px;
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
	@media (hover: none) and (pointer: coarse) {
		.close {
			width: 44px;
			height: 44px;
		}
	}
</style>
