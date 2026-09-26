<script lang="ts">
	import SiteNav from './SiteNav.svelte';
	import Wordmark from './Wordmark.svelte';
</script>

<header>
	<Wordmark />
	<SiteNav />
</header>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		background: var(--p1);
		border-bottom: 1px solid var(--line);
	}
</style>
