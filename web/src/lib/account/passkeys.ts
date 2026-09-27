// Signing in with passkeys, the browser's half (the Worker's is worker/src/passkeys.ts): ask the
// Worker for options and a ticket, let the browser's passkey dialog do its part, send the result
// back. A success sets the session cookie, which only /api sees.

import {
	browserSupportsWebAuthn,
	startAuthentication,
	startRegistration,
	WebAuthnError,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';

export { browserSupportsWebAuthn };

export interface Me {
	user: string;
	via: 'passkey' | 'dev';
	passkeys: number;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(body)
	});
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
	return data as T;
}

/** Who is signed in, or null. */
export async function me(): Promise<Me | null> {
	const res = await fetch('/api/me', { credentials: 'same-origin', redirect: 'manual' });
	return res.ok ? ((await res.json()) as Me) : null;
}

/** A readable reason for a failed passkey dialog, or null when the listener just cancelled. */
export function problem(e: unknown): string | null {
	const name = ((e instanceof WebAuthnError ? e.cause : e) as Error | undefined)?.name;
	if (name === 'NotAllowedError' || name === 'AbortError') return null;
	if (e instanceof WebAuthnError && e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
		return 'This device already has a giggle passkey for this account.';
	}
	return e instanceof Error ? e.message : String(e);
}

/** Makes a passkey: a new account, or (signed in) another device for this one. */
export async function createPasskey(): Promise<void> {
	const { ticket, options } = await post<{
		ticket: string;
		options: PublicKeyCredentialCreationOptionsJSON;
	}>('/api/passkey/register/options');
	const response = await startRegistration({ optionsJSON: options });
	await post('/api/passkey/register/verify', { ticket, response });
}

/** Signs in with whichever giggle passkey the browser or phone offers. */
export async function signIn(): Promise<void> {
	const { ticket, options } = await post<{
		ticket: string;
		options: PublicKeyCredentialRequestOptionsJSON;
	}>('/api/passkey/login/options');
	const response = await startAuthentication({ optionsJSON: options });
	await post('/api/passkey/login/verify', { ticket, response });
}

export async function signOut(): Promise<void> {
	await post('/api/logout');
}
