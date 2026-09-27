<!-- A modal dialog: a drawer from the right (a bottom sheet on phones), or a centred modal. It has
     a title and a close button, closes on Escape or a click on the backdrop, and keeps `open` in
     step with the <dialog> both ways. The body scrolls; an optional footer stays put. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		kind = 'drawer',
		id,
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		kind?: 'drawer' | 'modal';
		id?: string;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const titleId = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	{id}
	class="sheet {kind}"
	aria-labelledby={titleId}
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && dialog?.close()}
>
	<div class="frame">
		<header>
			<h2 class="display" id={titleId}>{title}</h2>
			<button type="button" class="close tap" onclick={() => dialog?.close()} aria-label="Close">
				<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
			</button>
		</header>
		<div class="body">{@render children()}</div>
		{#if footer}<footer>{@render footer()}</footer>{/if}
	</div>
</dialog>

<style>
	.sheet {
		padding: 0;
		border: 0;
		background: var(--p1);
		color: var(--ink);
		overscroll-behavior: contain;
	}
	.sheet::backdrop {
		background: rgb(0 0 0 / 0.5);
	}
	.drawer {
		margin: 0 0 0 auto;
		width: min(420px, 100vw);
		height: 100dvh;
		max-width: 100vw;
		max-height: 100dvh;
		border-left: 1px solid var(--line);
	}
	.modal {
		width: min(440px, calc(100vw - 32px));
		border: 1px solid var(--line);
		border-radius: 14px;
	}
	.frame {
		display: flex;
		flex-direction: column;
		max-height: inherit;
		height: 100%;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 16px 12px 20px;
		border-bottom: 1px solid var(--line);
	}
	.modal header {
		padding-bottom: 0;
		border-bottom: 0;
	}
	h2 {
		font-size: 32px;
	}
	.close {
		width: 36px;
		height: 36px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--p2);
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.close svg {
		width: 12px;
		height: 12px;
		stroke: var(--ink);
		stroke-width: 1.7;
		stroke-linecap: round;
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 18px 20px 28px;
		scrollbar-width: thin;
	}
	.modal .body {
		padding: 12px 20px 20px;
	}
	footer {
		display: flex;
		gap: 10px;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--line);
		background: var(--p1);
	}

	/* Phones: a drawer comes up from the bottom, most of the screen tall. */
	@media (max-width: 700px) {
		.drawer {
			margin: auto 0 0;
			width: 100vw;
			height: min(88dvh, 100dvh - 24px);
			border-left: 0;
			border-top: 1px solid var(--line);
			border-radius: 16px 16px 0 0;
		}
		.drawer header {
			padding: 12px 12px 10px 16px;
		}
		.drawer .body {
			padding: 14px 16px 24px;
		}
	}
</style>
