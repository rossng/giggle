<script lang="ts">
	let { href = '/agenda' }: { href?: string } = $props();
</script>

<a class="wordmark" {href} aria-label="giggle, Amsterdam: home"
	>giggle<span aria-hidden="true">AMS</span></a
>

<style>
	.wordmark {
		font: 800 30px/0.9 var(--f-display);
		letter-spacing: -0.01em;
		color: var(--ink);
		display: inline-flex;
		align-items: flex-start;
		gap: 5px;
		text-decoration: none;
	}
	span {
		font: 600 9px/1 var(--f-mono);
		letter-spacing: 0.1em;
		color: var(--bg);
		background: var(--amber);
		padding: 3px 4px;
		border-radius: 3px;
		margin-top: 3px;
	}
</style>
