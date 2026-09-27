<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { sync } from '$lib/sync/app';
	import type { SyncStatus } from '$lib/sync/client';

	/** Carried to Radio and Agenda so a station and its list stay in step. */
	let { query = '' }: { query?: string } = $props();

	const links = $derived([
		{ href: `/radio${query}`, path: '/radio', label: 'Radio' },
		{ href: `/agenda${query}`, path: '/agenda', label: 'Agenda' },
		{ href: '/board', path: '/board', label: 'Board' }
	]);

	// Signing in syncs the board, unavailable dates and play history across devices. In
	// production Access signs the browser in on the way to /api/login; `make dev` picks a fake
	// user instead (worker/README.md).
	let status: SyncStatus | null = $state(null);
	onMount(() => sync?.subscribe((s) => (status = s)));
	const here = $derived(encodeURIComponent(page.url.pathname + page.url.search));
	const signIn = $derived(
		import.meta.env.DEV
			? `/api/dev/login?as=you@example.test&next=${here}`
			: `/api/login?next=${here}`
	);
	const signOut = $derived(
		import.meta.env.DEV ? `/api/dev/logout?next=${here}` : '/cdn-cgi/access/logout'
	);
</script>

<nav aria-label="Main">
	{#each links as link (link.path)}
		<a href={link.href} aria-current={page.url.pathname.startsWith(link.path) ? 'page' : undefined}
			>{link.label}</a
		>
	{/each}
	{#if status?.state === 'signed-out'}
		<a class="account" href={signIn} data-sveltekit-reload title="Sync your board across devices"
			>Sign in</a
		>
	{:else if status?.user}
		<a class="account" href={signOut} data-sveltekit-reload title="Signed in as {status.user}"
			>Sign out</a
		>
	{/if}
</nav>

<style>
	nav {
		display: flex;
		flex-wrap: wrap;
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
	.account {
		font-weight: 500;
	}
</style>
