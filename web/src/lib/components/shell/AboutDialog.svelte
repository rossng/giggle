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
		<section class="terms" aria-labelledby="terms-title">
			<h3 id="terms-title" class="label">Terms</h3>
			<ul>
				<li>
					giggle is free and comes as is. As far as the law allows, I don't promise it works, stays
					up or keeps your data, and I'm not liable for anything that happens because you used it.
				</li>
				<li>
					Gig details come from the venues' own sites and can be wrong or out of date. Check with
					the venue before you buy a ticket.
				</li>
				<li>The music plays through YouTube, under YouTube's own terms.</li>
				<li>
					If you sign in, giggle keeps your board, unavailable dates and listening history so it can
					sync them between your devices. It has no ads and doesn't track you. You can delete your
					account and everything in it on the <a href="/account" onclick={() => (open = false)}
						>Account</a
					> page.
				</li>
			</ul>
		</section>
		<div class="seal">
			{#if sealReady}
				<seal-of-slop
					size="96"
					design="seal"
					text="This app was entirely vibe-coded, but I thought fairly carefully about the functionality I had and guided Claude. There is no support and it is provided as-is."
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
	.terms h3 {
		margin: 4px 0 6px;
	}
	.terms ul {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--mute);
	}
	.seal {
		display: flex;
		align-items: center;
		gap: 14px;
		min-height: 96px;
	}
</style>
