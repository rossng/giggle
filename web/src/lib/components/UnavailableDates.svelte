<script lang="ts">
	import { dayParts } from '$lib/data/dates';
	import type { IsoDate } from '$lib/data/types';
	import {
		describeRule,
		MAX_LABEL,
		rangeRule,
		upcomingRules,
		WEEKDAY_KEYS,
		WEEKDAY_NAMES
	} from '$lib/data/unavailable';
	import { unavailableDates } from '$lib/data/unavailable-store.svelte';

	// The listener's unavailable dates: weekdays toggle straight away; days and ranges are added
	// with the form. Saved on this device and synced to the account (unavailable-store).

	let { today, id = 'unavailable-dates' }: { today: IsoDate; id?: string } = $props();

	const rules = $derived(upcomingRules(unavailableDates.items, today));
	const dated = $derived(rules.filter((r) => r.rule.kind !== 'weekly'));
	const thisYear = $derived(dayParts(today).year);

	let from = $state('');
	let to = $state('');
	let label = $state('');
	const draft = $derived(from ? rangeRule(from, to || from) : null);
	const tooLong = $derived(!!from && !!to && !draft);

	function weekly(i: number): boolean {
		return `weekly:${WEEKDAY_KEYS[i]}` in unavailableDates.items;
	}

	function toggleWeekday(i: number) {
		if (weekly(i)) unavailableDates.remove(`weekly:${WEEKDAY_KEYS[i]}`);
		else unavailableDates.add({ kind: 'weekly', weekday: i });
	}

	function add(event: SubmitEvent) {
		event.preventDefault();
		if (!draft) return;
		unavailableDates.add(draft, label);
		from = '';
		to = '';
		label = '';
	}
</script>

<div class="dates" {id}>
	<span class="label sub" id="{id}-weekly">Every week</span>
	<div class="days" role="group" aria-labelledby="{id}-weekly">
		{#each WEEKDAY_NAMES as name, i (name)}
			<button
				type="button"
				aria-pressed={weekly(i)}
				aria-label="Every {name}"
				title="Every {name}"
				onclick={() => toggleWeekday(i)}>{name.slice(0, 2)}</button
			>
		{/each}
	</div>

	{#if dated.length}
		<ul class="list" aria-label="Unavailable dates">
			{#each dated as r (r.key)}
				<li>
					<span class="what">{describeRule(r.rule, thisYear)}</span>
					{#if r.label}<span class="note ellipsis">{r.label}</span>{/if}
					<button
						type="button"
						class="x tap"
						aria-label="Remove {describeRule(r.rule, thisYear)}"
						title="Remove"
						onclick={() => unavailableDates.remove(r.key)}>×</button
					>
				</li>
			{/each}
		</ul>
	{/if}

	<form onsubmit={add}>
		<span class="label sub">Add days</span>
		<div class="range">
			<label>
				<span class="visually-hidden">From</span>
				<input type="date" min={today} bind:value={from} required />
			</label>
			<span aria-hidden="true">–</span>
			<label>
				<span class="visually-hidden">To (optional, for a range)</span>
				<input type="date" min={from || today} bind:value={to} />
			</label>
		</div>
		<div class="range">
			<label class="grow">
				<span class="visually-hidden">Note (optional)</span>
				<input
					type="text"
					placeholder="Note, e.g. Lisbon"
					maxlength={MAX_LABEL}
					autocomplete="off"
					bind:value={label}
				/>
			</label>
			<button type="submit" class="button" disabled={!draft}>Add</button>
		</div>
		{#if tooLong}<p class="caption bad">At most a year at a time.</p>{/if}
	</form>
</div>

<style>
	.dates {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 10px;
		margin-left: 40px;
		min-width: 0;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.sub {
		margin-top: 2px;
	}
	.days {
		display: flex;
		gap: 3px;
	}
	.days button {
		flex: 1;
		border: 1px solid var(--line);
		background: none;
		border-radius: 6px;
		padding: 4px 0;
		font: 600 10.5px var(--f-mono);
		color: var(--mute);
		cursor: pointer;
	}
	.days button:hover {
		color: var(--ink);
	}
	.days button[aria-pressed='true'] {
		background: var(--amber);
		border-color: var(--amber);
		color: var(--bg);
	}
	.list {
		list-style: none;
		margin: 2px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.list li {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 12px;
	}
	.what {
		white-space: nowrap;
		flex: none;
	}
	.note {
		flex: 1;
		min-width: 0;
		color: var(--mute);
		font-size: 11px;
	}
	.x {
		margin-left: auto;
		flex: none;
		border: 0;
		background: none;
		padding: 0 4px;
		color: var(--mute);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
	}
	.x:hover {
		color: var(--bad);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 2px;
	}
	.range {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--mute);
	}
	.range label {
		flex: 1;
		min-width: 0;
	}
	input {
		width: 100%;
		min-width: 0;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 4px 6px;
		font-size: 11.5px;
	}
	input::placeholder {
		color: var(--mute);
	}
	.button {
		padding: 4px 10px;
		font-size: 11.5px;
	}
	.button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.caption {
		font: 500 11px var(--f-mono);
		color: var(--mute);
	}
	.bad {
		color: var(--bad);
	}

	/* Touch: every control at least ~44px tall, the list's × a full square. */
	@media (pointer: coarse) {
		.dates {
			gap: 10px;
		}
		.days button {
			min-height: 40px;
			font-size: 12px;
		}
		.list li {
			align-items: center;
			font-size: 13px;
		}
		.x {
			margin-right: -10px;
			font-size: 18px;
		}
		input {
			min-height: 44px;
			font-size: 16px; /* no zoom on focus in iOS */
			padding: 6px 8px;
		}
		.button {
			padding: 0 16px;
		}
	}

	/* Narrow screens: use the full width rather than indenting under the switch. */
	@media (max-width: 380px) {
		.dates {
			margin-left: 0;
		}
	}
</style>
