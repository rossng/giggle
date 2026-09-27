<!-- The same bar on every page: the wordmark, the three sections, and the account. On phones the
     sections move to the tab bar at the bottom (TabBar), next to the thumb. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Wordmark from '$lib/components/Wordmark.svelte';
	import { radioApp } from '$lib/radio/app.svelte';
	import { sync } from '$lib/sync/app';
	import type { SyncStatus } from '$lib/sync/client';
	import { isCurrent, sections } from './nav';

	const links = $derived(sections(radioApp.station));
	let status = $state<SyncStatus | null>(null);
	onMount(() => sync?.subscribe((s) => (status = s)));
	const signedIn = $derived(!!status?.user);
</script>

<header class="top">
	<Wordmark />
	<nav aria-label="Main">
		{#each links as link (link.path)}
			<a
				href={link.href}
				aria-current={isCurrent(page.url.pathname, link.path) ? 'page' : undefined}>{link.label}</a
			>
		{/each}
	</nav>
	<a
		class="account"
		href="/account"
		aria-current={page.url.pathname === '/account' ? 'page' : undefined}
		title={signedIn ? 'Your account: syncing across devices' : 'Sync your board across devices'}
		>{signedIn ? 'Account' : 'Sign in'}</a
	>
</header>

<style>
	.top {
		position: sticky;
		top: 0;
		/* Above the docked video, which scrolls under it with the Radio page. */
		z-index: 45;
		display: flex;
		align-items: center;
		gap: 24px;
		height: var(--top-h);
		padding: 0 16px;
		background: var(--p1);
		border-bottom: 1px solid var(--line);
	}
	nav {
		display: flex;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}
	a:not(:global(.wordmark)) {
		padding: 7px 11px;
		border-radius: 8px;
		color: var(--mute);
		font-weight: 600;
		font-size: 14px;
		text-decoration: none;
		white-space: nowrap;
	}
	a:not(:global(.wordmark)):hover {
		color: var(--ink);
	}
	a[aria-current='page'] {
		background: var(--p2);
		color: var(--ink);
	}
	.account {
		margin-left: auto;
		font-weight: 500;
	}
	@media (max-width: 700px) {
		nav {
			display: none;
		}
	}
	@media (hover: none) and (pointer: coarse) {
		.account {
			padding: 12px 14px;
		}
	}
</style>
