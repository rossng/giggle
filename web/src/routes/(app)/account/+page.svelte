<script lang="ts">
	// Signing in to sync the board, unavailable dates and play history across devices, with
	// passkeys: no password, no email. Everything works signed out too, on this device only.
	import { onMount } from 'svelte';
	import {
		browserSupportsWebAuthn,
		createPasskey,
		listPasskeys,
		me,
		problem,
		removePasskey,
		signIn,
		signOut,
		signOutEverywhere,
		type Me,
		type PasskeyInfo
	} from '$lib/account/passkeys';
	import More from '$lib/components/pages/More.svelte';
	import { sync } from '$lib/sync/app';

	let account: Me | null = $state(null);
	let loaded = $state(false);
	let busy = $state(false);
	let message: string | null = $state(null);
	let supported = $state(true);
	let passkeys: PasskeyInfo[] = $state([]);

	async function refresh() {
		account = await me().catch(() => null);
		passkeys = account?.via === 'passkey' ? await listPasskeys().catch(() => passkeys) : [];
		loaded = true;
	}

	const day = (iso: string) =>
		new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

	function remove(p: PasskeyInfo) {
		if (!confirm('Remove this passkey? It will no longer sign in to giggle.')) return;
		void run(
			() => removePasskey(p.id),
			'Passkey removed. Also delete it from your password manager or device.'
		);
	}

	function everywhere() {
		if (!confirm('Sign out on every device, this one included?')) return;
		void run(signOutEverywhere, 'Signed out everywhere. Your data stays on this device.');
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

<main class="page account">
	<header class="head">
		<h1 class="display page-title">Account</h1>
		<p class="sub">
			Your board, unavailable dates and listening history are saved on this device. Sign in to keep
			them the same on your phone, your laptop and anywhere else you use giggle.
		</p>
	</header>

	{#if !supported}
		<p class="note">This browser can't use passkeys, so everything stays on this device.</p>
	{:else if !loaded}
		<p class="note">Checking…</p>
	{:else if account}
		<section class="card">
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
				{#if account.via === 'passkey'}
					<button class="button" disabled={busy} onclick={everywhere}>Sign out everywhere</button>
				{/if}
			</div>
		</section>
		{#if account.via === 'passkey'}
			<More label="Use giggle on another device">
				<p>
					If both devices use the same password manager (say, two Apple devices with iCloud
					Keychain), your passkey is already there: open giggle on the other device, go to Account
					and press <b>Sign in with a passkey</b>.
				</p>
				<p>Otherwise, give the other device its own passkey:</p>
				<ol class="steps">
					<li>Press <b>Add a passkey</b> below.</li>
					<li>
						When your browser asks where to save it, choose <b>More options</b> (or "Use a phone or tablet")
						until you see a QR code.
					</li>
					<li>
						Scan the QR code with the other device's camera and save the passkey there. Both devices
						need Bluetooth switched on.
					</li>
					<li>
						On the other device, open giggle, go to Account and press <b>Sign in with a passkey</b>.
					</li>
				</ol>
				<div class="actions">
					<button
						class="button"
						disabled={busy}
						onclick={() =>
							run(createPasskey, 'Passkey added. You can sign in with it on that device now.')}
						>Add a passkey</button
					>
				</div>
			</More>
			<More label="Passkeys" summary={`${passkeys.length}`}>
				<ul class="passkeys">
					{#each passkeys as p (p.id)}
						<li>
							<div>
								<strong
									>{p.device_type === 'multiDevice'
										? 'Synced passkey'
										: 'Passkey on one device'}</strong
								>
								<span class="note">
									Added {day(p.created)}{p.last_used ? ` · last used ${day(p.last_used)}` : ''}
								</span>
							</div>
							<button
								class="button"
								disabled={busy || passkeys.length < 2}
								title={passkeys.length < 2 ? 'Your only passkey: add another first' : undefined}
								onclick={() => remove(p)}>Remove</button
							>
						</li>
					{/each}
				</ul>
				<p class="note">
					Lost a device? Remove its passkey, then sign out everywhere so its session ends too.
				</p>
			</More>
		{/if}
	{:else}
		<section class="card">
			<h2 class="label">Sign in</h2>
			<p>
				giggle uses a <b>passkey</b> instead of a password. A passkey is saved on your device, or in a
				password manager like iCloud Keychain, Google Password Manager or 1Password, and you unlock it
				the way you unlock your phone or laptop: fingerprint, face or PIN. No password, no email.
			</p>
			<p>
				<b>Already made one?</b> Sign in and pick it when your device asks. If it's on a different
				device, like your phone, choose <b>More options</b> (or "Use a phone or tablet") in that window
				to get a QR code, and scan it with the device that has the passkey.
			</p>
			<p>
				<b>First time?</b> Create a passkey. Whatever you've sorted on this device becomes your account.
			</p>
			<div class="actions">
				<button
					class="button strong"
					disabled={busy}
					onclick={() => run(signIn, 'Signed in: syncing now.')}>Sign in with a passkey</button
				>
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
		gap: 16px;
	}
	.head {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.sub,
	.note {
		color: var(--mute);
	}
	.card {
		padding: 16px;
		background: var(--p1);
		border: 1px solid var(--line);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.card p,
	.steps {
		margin: 0;
		line-height: 1.5;
	}
	.steps {
		padding-left: 20px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.passkeys {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.passkeys li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.passkeys li > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	@media (max-width: 520px) {
		.actions > .button {
			flex: 1 1 100%;
			justify-content: center;
		}
	}
</style>
