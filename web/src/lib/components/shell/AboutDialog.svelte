<!-- What giggle is and who made it, from the top bar's "About". -->
<script lang="ts">
	import Sheet from '$lib/components/Sheet.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let sealReady = $state(false);
	// The seal is a web component (WebGL): only loaded when someone opens About.
	$effect(() => {
		if (open && !sealReady)
			void import('seal-of-slop').then(
				() => (sealReady = true),
				() => {}
			);
	});
</script>

<Sheet bind:open title="About giggle" kind="modal">
	<div class="about">
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
</Sheet>

<style>
	.about {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
</style>
