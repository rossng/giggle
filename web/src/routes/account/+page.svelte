<script lang="ts">
	// Signing in to sync the board, unavailable dates and play history across devices, with
	// passkeys: no password, no email. Everything works signed out too, on this device only.
	import { onMount } from 'svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import {
		browserSupportsWebAuthn,
		createPasskey,
		me,
		problem,
		signIn,
		signOut,
		type Me
	} from '$lib/account/passkeys';
	import { sync } from '$lib/sync/app';

	let account: Me | null = $state(null);
	let loaded = $state(false);
	let busy = $state(false);
	let message: string | null = $state(null);
	let supported = $state(true);

	async function refresh() {
		account = await me().catch(() => null);
		loaded = true;
	}

	onMount(() => {
		supported = browserSupportsWebAuthn();
		void refresh();
	});

	/** Runs a passkey step, then catches the sync up with whoever is signed in now. */
	async function run(step: () => Promise<void>, done: string) {
		busy = true;
		message = null;
		try {
			await step();
			message = done;
			await refresh();
			void sync?.syncNow();
		} catch (e) {
			message = problem(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Account · giggle</title></svelte:head>

<SiteHeader />
<main class="page account">
	<header>
		<p class="label eyebrow">Sync</p>
		<h1 class="display big">Account</h1>
		<p class="sub">
			giggle keeps your board, unavailable dates and listening history on this device. Sign in with
			a passkey to keep them in step on all your devices. There's no password or email: your phone,
			computer or password manager holds the key.
		</p>
	</header>

	{#if !supported}
		<p class="note">This browser can't use passkeys, so everything stays on this device.</p>
	{:else if !loaded}
		<p class="note">Checking…</p>
	{:else if account}
		<section>
			<h2 class="label">Signed in</h2>
			<p>
				{#if account.via === 'dev'}
					As {account.user} (dev identity).
				{:else}
					Your board syncs across your devices. This account has {account.passkeys}
					{account.passkeys === 1 ? 'passkey' : 'passkeys'}.
				{/if}
			</p>
			<div class="actions">
				<button
					class="button"
					disabled={busy}
					onclick={() => run(signOut, 'Signed out. Your data stays on this device.')}
					>Sign out</button
				>
			</div>
		</section>
		{#if account.via === 'passkey'}
			<section>
				<h2 class="label">Another device</h2>
				<p>
					If your password manager syncs passkeys (iCloud Keychain, Google, 1Password…), just sign
					in there. On a device without it, sign in with your phone (the browser offers a QR code),
					then add a passkey here so it signs in on its own next time.
				</p>
				<div class="actions">
					<button
						class="button"
						disabled={busy}
						onclick={() => run(createPasskey, 'Added a passkey for this device.')}
						>Add a passkey on this device</button
					>
				</div>
			</section>
		{/if}
	{:else}
		<section>
			<h2 class="label">Sign in</h2>
			<p>Made a giggle passkey before, here or on another device? Your browser offers it.</p>
			<div class="actions">
				<button
					class="button strong"
					disabled={busy}
					onclick={() => run(signIn, 'Signed in: syncing now.')}>Sign in with a passkey</button
				>
			</div>
		</section>
		<section>
			<h2 class="label">New here</h2>
			<p>
				Make a passkey for giggle. What's on this device becomes your synced board, and your other
				devices can sign in with the same passkey.
			</p>
			<div class="actions">
				<button
					class="button"
					disabled={busy}
					onclick={() => run(createPasskey, 'Passkey made: you’re signed in and syncing.')}
					>Create a passkey</button
				>
			</div>
		</section>
	{/if}

	{#if message}<p class="note" role="status">{message}</p>{/if}
</main>

<style>
	.account {
		max-width: 640px;
	}
	.eyebrow {
		color: var(--amber);
	}
	.big {
		font-size: 64px;
		margin: 0;
	}
	.sub,
	.note {
		color: var(--mute);
	}
	section {
		padding: 16px;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 10px;
	}
	h2 {
		margin: 0 0 8px;
	}
	section p {
		margin: 0 0 12px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
