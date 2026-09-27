// Signing in with passkeys, the browser's half (the Worker's is worker/src/passkeys.ts): ask the
// Worker for options and a ticket, let the browser's passkey dialog do its part, send the result
// back. A success sets the session cookie, which page scripts never see.
//
// Adding or removing a passkey and deleting the account need the session confirmed with a
// passkey in the last few minutes: `confirmed(step)` runs a step, and if the Worker asks for that
// (403 {reauth: true}) shows the passkey dialog once and runs it again.

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

/** A refused API call, with the Worker's reason. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** The session must be confirmed with a passkey first. */
		readonly reauth = false
	) {
		super(message);
	}
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
		credentials: 'same-origin',
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const data = (await res.json().catch(() => ({}))) as { error?: string; reauth?: boolean };
	if (!res.ok) {
		throw new ApiError(res.status, data.error ?? `${path}: ${res.status}`, data.reauth === true);
	}
	return data as T;
}

const post = <T>(path: string, body: unknown = {}) => send<T>('POST', path, body);

/** A signed-in GET's JSON; a refusal throws ApiError (`reauth` when a passkey must confirm). */
export const getJson = <T>(path: string) => send<T>('GET', path);

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

/** Confirms the signed-in session with one of this account's passkeys. */
export async function confirmIt(): Promise<void> {
	const { ticket, options } = await post<{
		ticket: string;
		options: PublicKeyCredentialRequestOptionsJSON;
	}>('/api/passkey/reauth/options');
	const response = await startAuthentication({ optionsJSON: options });
	await post('/api/passkey/reauth/verify', { ticket, response });
}

/** Runs `step`; if the Worker wants the session confirmed first, confirms it and runs it again. */
export async function confirmed<T>(step: () => Promise<T>): Promise<T> {
	try {
		return await step();
	} catch (e) {
		if (!(e instanceof ApiError && e.reauth)) throw e;
	}
	await confirmIt();
	return step();
}

export async function signOut(): Promise<void> {
	await post('/api/logout');
}

/** Ends every signed-in browser of this account, this one included. */
export async function signOutEverywhere(): Promise<void> {
	await post('/api/logout-everywhere');
}

/** One of the account's passkeys, as `GET /api/passkeys` lists it. */
export interface PasskeyInfo {
	id: string;
	created: string;
	last_used: string | null;
	/** 'multiDevice': synced by a password manager; 'singleDevice': on one device only. */
	device_type: string;
	backed_up: boolean;
	transports: string[];
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
	const data = await send<{ passkeys?: PasskeyInfo[] }>('GET', '/api/passkeys');
	return data.passkeys ?? [];
}

/**
 * Removes a passkey from the account (the server refuses the last one). Its sessions end with it:
 * `signedOut` when this browser's was one of them.
 */
export async function removePasskey(id: string): Promise<{ signedOut: boolean }> {
	const data = await send<{ signedOut?: boolean }>(
		'DELETE',
		`/api/passkeys/${encodeURIComponent(id)}`
	);
	return { signedOut: data.signedOut === true };
}

/** Deletes the account and everything giggle keeps about it, and signs out everywhere. */
export async function deleteAccount(): Promise<void> {
	await send('DELETE', '/api/account');
}
