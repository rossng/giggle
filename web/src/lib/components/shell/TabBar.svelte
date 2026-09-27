<!-- Phones: the sections as tabs at the bottom, under the player bar. -->
<script lang="ts">
	import { page } from '$app/state';
	import { radioApp } from '$lib/radio/app.svelte';
	import { isCurrent, sections } from './nav';

	const links = $derived(sections(radioApp.station));
	const ICONS: Record<string, string> = {
		'/radio': 'M4 9a8 8 0 0 1 12 0M6.5 11.5a4.5 4.5 0 0 1 7 0M10 14.5v.01',
		'/agenda': 'M4 5h12v11H4zM4 8.5h12M8 3v3M12 3v3',
		'/board': 'M3.5 4h4v12h-4zM8.5 4h4v8h-4zM13.5 4h3v5h-3z'
	};
</script>

<nav class="tabs" aria-label="Main">
	{#each links as link (link.path)}
		<a href={link.href} aria-current={isCurrent(page.url.pathname, link.path) ? 'page' : undefined}>
			<svg viewBox="0 0 20 20" aria-hidden="true"
				><path
					d={ICONS[link.path]}
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/></svg
			>
			{link.label}
		</a>
	{/each}
</nav>

<style>
	.tabs {
		display: none;
	}
	@media (max-width: 700px) {
		.tabs {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 40;
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			height: var(--tabs-h);
			padding-bottom: env(safe-area-inset-bottom);
			background: var(--p1);
			border-top: 1px solid var(--line);
		}
		a {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 2px;
			color: var(--mute);
			font-size: 11px;
			font-weight: 600;
			text-decoration: none;
		}
		a[aria-current='page'] {
			color: var(--ink);
		}
		svg {
			width: 22px;
			height: 22px;
		}
	}
</style>
