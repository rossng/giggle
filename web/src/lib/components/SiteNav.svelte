<script lang="ts">
	import { page } from '$app/state';

	/** Carried to Radio and Agenda so a station and its list stay in step. */
	let { query = '' }: { query?: string } = $props();

	const links = $derived([
		{ href: `/radio${query}`, path: '/radio', label: 'Radio' },
		{ href: `/agenda${query}`, path: '/agenda', label: 'Agenda' },
		{ href: '/board', path: '/board', label: 'Board' }
	]);
</script>

<nav aria-label="Main">
	{#each links as link (link.path)}
		<a href={link.href} aria-current={page.url.pathname.startsWith(link.path) ? 'page' : undefined}
			>{link.label}</a
		>
	{/each}
</nav>

<style>
	nav {
		display: flex;
		gap: 2px;
	}
	a {
		padding: 6px 9px;
		border-radius: 7px;
		color: var(--mute);
		font-weight: 600;
		font-size: 13px;
		text-decoration: none;
	}
	a:hover {
		color: var(--ink);
	}
	a[aria-current='page'] {
		background: var(--p2);
		color: var(--ink);
	}
</style>
