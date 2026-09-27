<script lang="ts">
	// The site owner's admin panel: how many people use giggle, how much they store, and anything
	// that looks like abuse. Not in the nav. Only accounts in the Worker's ADMIN_ACCOUNTS see it,
	// after confirming with their passkey; anyone else gets the API's "not found", and this page
	// looks like any missing one. Counts and sizes only: never anyone's board, dates or plays.
	import { onMount } from 'svelte';
	import { ApiError, confirmed, problem } from '$lib/account/passkeys';
	import { loadOverview, type AdminUser, type Overview } from '$lib/admin/api';
	import Chart from '$lib/admin/Chart.svelte';
	import {
		activeWithin,
		daily,
		flags,
		formatBytes,
		shortDate,
		sinceDay,
		sortUsers,
		totalRows,
		weekly,
		type SortKey
	} from '$lib/admin/stats';

	type View =
		| { is: 'loading' }
		| { is: 'confirm'; message: string | null }
		| { is: 'missing' }
		| { is: 'error'; message: string }
		| { is: 'ready'; data: Overview };

	let view = $state<View>({ is: 'loading' });
	let busy = $state(false);
	let per: 'day' | 'week' = $state('day');
	let sortKey: SortKey = $state('last_seen');
	let desc = $state(true);

	/** Days the daily charts show; the weekly one uses all the overview's whole weeks. */
	const DAYS = 90;

	/** Loads the overview, confirming with a passkey first if the Worker asks. */
	async function load() {
		busy = true;
		try {
			view = { is: 'ready', data: await confirmed(loadOverview) };
		} catch (e) {
			if (e instanceof ApiError && (e.status === 404 || e.status === 401)) view = { is: 'missing' };
			else if (e instanceof ApiError) view = { is: 'error', message: e.message };
			// The passkey dialog was cancelled or refused (some browsers want a click first).
			else view = { is: 'confirm', message: problem(e) };
		} finally {
			busy = false;
		}
	}

	onMount(() => void load());

	const data = $derived(view.is === 'ready' ? view.data : null);
	const warnings = $derived(data ? flags(data) : []);
	const flagged = $derived(new Set(warnings.flatMap((f) => f.ids)));
	const signups = $derived.by(() => {
		if (!data) return [];
		const days = daily(data.days, 'new_accounts', data.today, 98);
		return per === 'day' ? days.slice(-DAYS) : weekly(days);
	});
	const active = $derived(data ? daily(data.days, 'active_users', data.today, DAYS) : []);
	const users = $derived(data ? sortUsers(data.users, sortKey, desc) : []);

	const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
		{ key: 'id', label: 'Account', numeric: false },
		{ key: 'last_seen', label: 'Last seen', numeric: false },
		{ key: 'created', label: 'Joined', numeric: false },
		{ key: 'rows', label: 'Rows', numeric: true },
		{ key: 'bytes', label: 'Stored', numeric: true },
		{ key: 'written_today', label: 'Today', numeric: true },
		{ key: 'passkeys', label: 'Passkeys', numeric: true },
		{ key: 'sessions', label: 'Sessions', numeric: true }
	];

	function sortBy(key: SortKey) {
		if (sortKey === key) desc = !desc;
		else {
			sortKey = key;
			desc = key !== 'id';
		}
	}

	const n = (value: number) => value.toLocaleString('en-GB');
	const breakdown = (u: AdminUser) =>
		`board ${n(u.rows.board)} · dates ${n(u.rows.unavailable)} · plays ${n(u.rows.plays)}`;
	const time = (iso: string) =>
		new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

	// Platform numbers (requests, errors, D1 reads and writes against the free plan) live in
	// Cloudflare's dashboard; `:account` picks the signed-in account.
	const DASHBOARD = 'https://dash.cloudflare.com/?to=/:account';
</script>

<svelte:head>
	<title>{view.is === 'missing' ? '404' : 'Admin'} · giggle</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if view.is === 'missing'}
	<main class="page">
		<p class="label">Error 404</p>
		<h1 class="display big">Not found</h1>
		<p><a class="button" href="/agenda">Back to the agenda</a></p>
	</main>
{:else}
	<main class="page admin">
		<header class="head">
			<h1 class="display page-title">Admin</h1>
			{#if data}
				<p class="sub">
					Updated {time(data.now)} ·
					<button class="linkish" disabled={busy} onclick={load}>Refresh</button>
				</p>
			{/if}
		</header>

		{#if view.is === 'loading'}
			<p class="note">Loading…</p>
		{:else if view.is === 'confirm'}
			<section class="card">
				<h2 class="label">Confirm it's you</h2>
				<p>The admin panel asks for your passkey every few minutes.</p>
				<div>
					<button class="button strong" disabled={busy} onclick={load}
						>Confirm with a passkey</button
					>
				</div>
				{#if view.message}<p class="note" role="status">{view.message}</p>{/if}
			</section>
		{:else if view.is === 'error'}
			<section class="card">
				<p>Couldn't load the admin panel: {view.message}</p>
				<div><button class="button" disabled={busy} onclick={load}>Try again</button></div>
			</section>
		{:else if data}
			<section aria-labelledby="flags-title" class="flags">
				<h2 id="flags-title" class="label">Flags</h2>
				{#if warnings.length}
					<ul>
						{#each warnings as flag (flag.title)}
							<li>
								<span class="mark" aria-hidden="true">!</span>
								<div>
									<strong>{flag.title}</strong>
									<span class="note">
										{flag.detail}
										{#if flag.ids.length}Marked below: {flag.ids.join(', ')}.{/if}
									</span>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="note">Nothing looks off.</p>
				{/if}
			</section>

			<section aria-label="Totals" class="tiles">
				<div class="tile"><span class="label">Accounts</span><b>{n(data.totals.users)}</b></div>
				<div class="tile">
					<span class="label">Active 7 days</span><b>{n(activeWithin(data.users, data.today, 7))}</b
					>
				</div>
				<div class="tile">
					<span class="label">Active 30 days</span><b
						>{n(activeWithin(data.users, data.today, 30))}</b
					>
				</div>
				<div class="tile"><span class="label">Synced rows</span><b>{n(data.totals.rows)}</b></div>
				<div class="tile">
					<span class="label">Stored</span><b>{formatBytes(data.totals.bytes)}</b>
				</div>
				<div class="tile">
					<span class="label">Database</span>
					<b>{data.totals.dbBytes === null ? '–' : formatBytes(data.totals.dbBytes)}</b>
				</div>
			</section>

			<div class="charts">
				<section class="card" aria-labelledby="signups-title">
					<div class="card-head">
						<h2 id="signups-title" class="label">New accounts</h2>
						<div class="seg" role="group" aria-label="Per">
							<button aria-pressed={per === 'day'} onclick={() => (per = 'day')}>Day</button>
							<button aria-pressed={per === 'week'} onclick={() => (per = 'week')}>Week</button>
						</div>
					</div>
					<Chart
						points={signups}
						label={per === 'day' ? 'New accounts a day' : 'New accounts a week'}
						unit={['new account', 'new accounts']}
						when={per === 'day'
							? (d) => shortDate(d, true)
							: (d) => `week of ${shortDate(d, true)}`}
					/>
				</section>
				<section class="card" aria-labelledby="active-title">
					<div class="card-head">
						<h2 id="active-title" class="label">Active accounts a day</h2>
					</div>
					<Chart
						points={active}
						kind="line"
						label="Active accounts a day"
						unit={['active account', 'active accounts']}
						when={(d) => shortDate(d, true)}
					/>
				</section>
			</div>

			<section aria-labelledby="users-title" class="users">
				<h2 id="users-title" class="label">Accounts ({n(data.users.length)})</h2>
				<div class="scroll">
					<table>
						<thead>
							<tr>
								{#each COLUMNS as c (c.key)}
									<th
										scope="col"
										class:num={c.numeric}
										aria-sort={sortKey === c.key ? (desc ? 'descending' : 'ascending') : 'none'}
									>
										<button onclick={() => sortBy(c.key)}>
											{c.label}<span class="arrow" aria-hidden="true"
												>{sortKey === c.key ? (desc ? '↓' : '↑') : ''}</span
											>
										</button>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each users as u, i (`${u.id}-${i}`)}
								<tr class:flagged={flagged.has(u.id)}>
									<th scope="row">
										<span class="who">
											<code>{u.id}</code>
											{#if u.you}<span class="tag">you</span>{/if}
											{#if flagged.has(u.id)}<span class="mark" title="Flagged above">!</span>{/if}
										</span>
									</th>
									<td title={u.last_seen ?? undefined}>{sinceDay(u.last_seen, data.today)}</td>
									<td title={u.passkey_used ? `Passkey last used ${u.passkey_used}` : undefined}
										>{shortDate(u.created, true)}</td
									>
									<td class="num" title={breakdown(u)}>{n(totalRows(u))}</td>
									<td class="num">{formatBytes(u.bytes)}</td>
									<td class="num">{u.written_today ? n(u.written_today) : '–'}</td>
									<td class="num">{u.passkeys}</td>
									<td class="num">{u.sessions}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note">
					Rows: board, unavailable dates and plays together, deletions included (hover for each).
					Stored: their keys and contents in bytes. Today: rows written today, of {n(
						data.limits.dailyRows
					)} a day. Last seen is a day (UTC); giggle keeps no other activity per account.
				</p>
			</section>

			<section class="card" aria-labelledby="platform-title">
				<h2 id="platform-title" class="label">Platform</h2>
				<p>
					Requests, errors, and D1 reads, writes and storage against the free plan's limits are in
					Cloudflare's dashboard.
				</p>
				<div class="links">
					<a
						class="button"
						href="{DASHBOARD}/workers/services/view/giggle/production"
						target="_blank"
						rel="noopener">Worker metrics ↗</a
					>
					<a class="button" href="{DASHBOARD}/workers/d1" target="_blank" rel="noopener">D1 ↗</a>
					<a class="button" href="{DASHBOARD}/workers/plans" target="_blank" rel="noopener"
						>Plan usage ↗</a
					>
				</div>
			</section>
		{/if}
	</main>
{/if}

<style>
	.big {
		font-size: 56px;
	}
	.admin {
		gap: 18px;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px 16px;
	}
	.sub,
	.note {
		color: var(--mute);
	}
	.note {
		font-size: 12.5px;
	}
	.linkish {
		border: 0;
		background: none;
		padding: 0;
		color: var(--amber);
		cursor: pointer;
		text-decoration: underline;
	}
	.card {
		padding: 16px;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 32px;
	}
	.card-head .seg {
		flex: none;
	}
	.flags {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.flags ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.flags li {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
		background: color-mix(in srgb, var(--bad) 7%, var(--p1));
		border-radius: 10px;
	}
	.flags li > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mark {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--bad);
		color: var(--bg);
		font: 700 11px/1 var(--f-mono);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 8px;
	}
	.tile {
		padding: 12px 14px;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.tile b {
		font: 800 30px/1 var(--f-display);
		font-variant-numeric: tabular-nums;
	}
	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
		gap: 12px;
	}
	.users {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}
	.scroll {
		overflow-x: auto;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--p1);
		max-height: 70vh;
		overflow-y: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12.5px;
		font-variant-numeric: tabular-nums;
	}
	thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--p2);
		text-align: left;
		padding: 0;
		white-space: nowrap;
	}
	thead button {
		width: 100%;
		border: 0;
		background: none;
		padding: 9px 10px;
		font: 600 10px/1 var(--f-mono);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--mute);
		cursor: pointer;
		text-align: inherit;
		min-height: 36px;
	}
	thead th[aria-sort='ascending'] button,
	thead th[aria-sort='descending'] button,
	thead button:hover {
		color: var(--ink);
	}
	.arrow {
		display: inline-block;
		width: 1em;
	}
	th.num,
	td.num {
		text-align: right;
	}
	tbody th,
	td {
		padding: 7px 10px;
		border-top: 1px solid var(--line);
		white-space: nowrap;
		text-align: left;
		font-weight: 400;
	}
	tbody th {
		position: sticky;
		left: 0;
		background: var(--p1);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	tr.flagged > * {
		background: color-mix(in srgb, var(--bad) 8%, var(--p1));
	}
	code {
		font-family: var(--f-mono);
		font-size: 12px;
	}
	.tag {
		font-size: 10.5px;
		padding: 1px 6px;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	@media (max-width: 520px) {
		.big {
			font-size: 44px;
		}
		.tile b {
			font-size: 26px;
		}
		.links > .button {
			flex: 1 1 100%;
			justify-content: center;
		}
	}
	@media (pointer: coarse) {
		thead button {
			min-height: 44px;
		}
	}
</style>
