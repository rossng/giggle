<!-- Sorting one artist onto the board, as the radio does: listen more, want to go, got tickets,
     not for me. Pressing the current state again takes them off the board. -->
<script lang="ts">
	import { TRIAGES, TRIAGE_LABELS, type Triage } from '$lib/board/board';
	import { liveBoard, sortArtist } from '$lib/board/live';
	import type { Catalog } from '$lib/data/catalog';
	import type { Gig } from '$lib/data/types';

	let {
		catalog,
		artistKey,
		name,
		gig = null
	}: {
		catalog: Catalog;
		artistKey: string;
		name: string;
		/** The gig they're being sorted for (their next one), so the Board can show it. */
		gig?: Pick<Gig, 'id' | 'start'> | null;
	} = $props();

	const state = $derived(liveBoard(catalog)[artistKey]?.state ?? null);

	function pick(t: Triage) {
		sortArtist(catalog, artistKey, state === t ? null : t, {
			name,
			...(gig ? { gig: gig.id, when: gig.start } : {})
		});
	}
</script>

<div class="sort" role="group" aria-label="Sort {name}">
	{#each TRIAGES as t (t)}
		<button
			type="button"
			class="s-{t}"
			class:on={state === t}
			aria-pressed={state === t}
			title={state === t ? 'Take them off your board' : undefined}
			onclick={() => pick(t)}><i class="mark" aria-hidden="true"></i>{TRIAGE_LABELS[t]}</button
		>
	{/each}
</div>

<style>
	.sort {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
		container-type: inline-size;
	}
	button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		min-width: 0;
		min-height: 38px;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--p1);
		color: var(--ink);
		font-weight: 600;
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--mute);
	}
	.mark {
		width: 8px;
		height: 8px;
		border-radius: 3px;
		flex: none;
	}
	.s-listen .mark {
		background: #8ea3ff;
	}
	.s-go .mark {
		background: var(--amber);
	}
	.s-tickets .mark {
		background: #7fd1a0;
	}
	.s-nope .mark {
		border: 1.5px solid var(--mute);
	}
	.s-nope {
		color: var(--mute);
	}
	button.on {
		border-color: transparent;
		color: var(--bg);
	}
	button.on .mark {
		background: rgb(0 0 0 / 0.3);
		border-color: transparent;
	}
	.s-listen.on {
		background: #8ea3ff;
	}
	.s-go.on {
		background: var(--amber);
	}
	.s-tickets.on {
		background: #7fd1a0;
	}
	.s-nope.on {
		background: var(--mute);
	}
	@media (max-width: 520px) {
		.sort {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (pointer: coarse) {
		button {
			min-height: 44px;
		}
	}
</style>
