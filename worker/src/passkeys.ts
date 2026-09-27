// Passkeys (WebAuthn) for signing in, via @simplewebauthn/server. No passwords, no email: an
// account is an id with one or more passkeys, and a passkey synced by the listener's password
// manager (iCloud, Google, 1Password…) signs them in on their other devices; a device without it
// can use the browser's "use a phone" QR flow.
//
//   POST /api/passkey/register/options  {}                  → {ticket, options}
//   POST /api/passkey/register/verify   {ticket, response}  → {user, via} + session cookie
//   POST /api/passkey/login/options     {}                  → {ticket, options}
//   POST /api/passkey/login/verify      {ticket, response}  → {user, via} + session cookie
//
// Registering while signed in with a passkey adds one to that account (a new device); otherwise it
// makes a new account. Each ceremony's challenge is stored under a random ticket for five minutes
// and used once.

import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { newToken, startSession, type Identity } from './auth';
import type { AuthConfig } from './config';

export const PASSKEY_PREFIX = '/api/passkey/';
const CHALLENGE_MS = 5 * 60 * 1000;
/** Passkeys per account: plenty for a person's devices, not a way to fill the database. */
export const MAX_PASSKEYS = 20;
const RP_NAME = 'giggle';

export class PasskeyError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

interface Ticketed<T> {
	ticket: string;
	response: T;
}

function ticketed<T>(body: unknown): Ticketed<T> {
	const b = body as Partial<Ticketed<T>> | null;
	if (!b || typeof b.ticket !== 'string' || !b.response || typeof b.response !== 'object') {
		throw new PasskeyError(400, 'expected {ticket, response}');
	}
	return b as Ticketed<T>;
}

async function saveChallenge(
	db: D1Database,
	challenge: string,
	purpose: 'register' | 'login',
	account: string | null,
	existing: boolean,
	now: number
): Promise<string> {
	const ticket = newToken();
	await db.batch([
		// Ceremonies nobody finished: tidy them away as new ones start.
		db.prepare('DELETE FROM challenges WHERE expires < ?').bind(new Date(now).toISOString()),
		db
			.prepare(
				'INSERT INTO challenges (id, challenge, purpose, account, existing, expires) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.bind(
				ticket,
				challenge,
				purpose,
				account,
				existing ? 1 : 0,
				new Date(now + CHALLENGE_MS).toISOString()
			)
	]);
	return ticket;
}

/** The ticket's challenge, removed so it can't be used twice. */
async function takeChallenge(
	db: D1Database,
	ticket: string,
	purpose: 'register' | 'login',
	now: number
): Promise<{ challenge: string; account: string | null; existing: boolean }> {
	const row = await db
		.prepare(
			'DELETE FROM challenges WHERE id = ? AND purpose = ? RETURNING challenge, account, existing, expires'
		)
		.bind(ticket, purpose)
		.first<{ challenge: string; account: string | null; existing: number; expires: string }>();
	if (!row || Date.parse(row.expires) < now) {
		throw new PasskeyError(400, 'this sign-in took too long or was already used: try again');
	}
	return { challenge: row.challenge, account: row.account, existing: row.existing === 1 };
}

async function passkeysOf(db: D1Database, account: string) {
	const { results } = await db
		.prepare('SELECT id, transports FROM passkeys WHERE account = ?')
		.bind(account)
		.all<{ id: string; transports: string }>();
	return results.map((r) => ({
		id: r.id,
		transports: JSON.parse(r.transports) as AuthenticatorTransport[]
	}));
}

export async function passkeyCount(db: D1Database, account: string): Promise<number> {
	const row = await db
		.prepare('SELECT count(*) AS n FROM passkeys WHERE account = ?')
		.bind(account)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function registerOptions(
	db: D1Database,
	config: AuthConfig,
	signedIn: Identity | null,
	now = Date.now()
) {
	// A passkey user adding a device joins their account; anyone else starts a new one.
	const existing = signedIn?.via === 'passkey';
	const account = existing ? signedIn.user : `u_${crypto.randomUUID()}`;
	const current = existing ? await passkeysOf(db, account) : [];
	if (current.length >= MAX_PASSKEYS) {
		throw new PasskeyError(409, `an account can have at most ${MAX_PASSKEYS} passkeys`);
	}
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: config.rpID,
		userID: new Uint8Array(new TextEncoder().encode(account)),
		// What password managers show next to the passkey.
		userName: 'giggle',
		userDisplayName: 'giggle',
		attestationType: 'none',
		excludeCredentials: current,
		authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
	});
	const ticket = await saveChallenge(db, options.challenge, 'register', account, existing, now);
	return { ticket, options };
}

export async function registerVerify(
	db: D1Database,
	config: AuthConfig,
	body: unknown,
	url: URL,
	now = Date.now()
): Promise<{ identity: Identity; cookie: string }> {
	const { ticket, response } = ticketed<RegistrationResponseJSON>(body);
	const { challenge, account, existing } = await takeChallenge(db, ticket, 'register', now);
	if (!account) throw new PasskeyError(400, 'bad ticket');
	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: config.origins,
			expectedRPID: config.rpID,
			requireUserVerification: false
		});
	} catch (e) {
		throw new PasskeyError(400, `passkey not accepted: ${(e as Error).message}`);
	}
	if (!verification.verified || !verification.registrationInfo) {
		throw new PasskeyError(400, 'passkey not accepted');
	}
	const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
	const created = new Date(now).toISOString();
	const statements = [];
	if (!existing) {
		statements.push(
			db.prepare('INSERT INTO accounts (id, created) VALUES (?, ?)').bind(account, created)
		);
	}
	// MAX_PASSKEYS again, in the same statement as the insert: several tickets issued while the
	// account was under the limit must not take it over.
	statements.push(
		db
			.prepare(
				`INSERT INTO passkeys (id, account, public_key, counter, transports, device_type, backed_up, created)
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
				 WHERE (SELECT count(*) FROM passkeys WHERE account = ?2) < ?9`
			)
			.bind(
				credential.id,
				account,
				credential.publicKey,
				credential.counter,
				JSON.stringify(credential.transports ?? []),
				credentialDeviceType,
				credentialBackedUp ? 1 : 0,
				created,
				MAX_PASSKEYS
			)
	);
	let results;
	try {
		results = await db.batch(statements);
	} catch {
		throw new PasskeyError(409, 'this passkey is already registered');
	}
	if (!results[results.length - 1]!.meta.changes) {
		throw new PasskeyError(409, `an account can have at most ${MAX_PASSKEYS} passkeys`);
	}
	const cookie = await startSession(db, account, url, now);
	return { identity: { user: account, via: 'passkey' }, cookie };
}

export interface PasskeyInfo {
	id: string;
	created: string;
	last_used: string | null;
	/** 'multiDevice' (synced by a password manager) or 'singleDevice'. */
	device_type: string;
	backed_up: boolean;
	/** How the browser reached it: "internal", "hybrid", "usb"… */
	transports: string[];
}

/** An account's passkeys, oldest first, without their public keys. */
export async function listPasskeys(db: D1Database, account: string): Promise<PasskeyInfo[]> {
	const { results } = await db
		.prepare(
			`SELECT id, created, last_used, device_type, backed_up, transports FROM passkeys
			 WHERE account = ? ORDER BY created, id`
		)
		.bind(account)
		.all<
			Omit<PasskeyInfo, 'backed_up' | 'transports'> & { backed_up: number; transports: string }
		>();
	return results.map((r) => ({
		...r,
		backed_up: r.backed_up === 1,
		transports: JSON.parse(r.transports) as string[]
	}));
}

/** Removes one of the account's passkeys, never its last one (that would lock them out). */
export async function deletePasskey(db: D1Database, account: string, id: string): Promise<void> {
	const { meta } = await db
		.prepare(
			`DELETE FROM passkeys WHERE id = ?1 AND account = ?2
			 AND (SELECT count(*) FROM passkeys WHERE account = ?2) > 1`
		)
		.bind(id, account)
		.run();
	if (meta.changes) return;
	const mine = await db
		.prepare('SELECT 1 FROM passkeys WHERE id = ? AND account = ?')
		.bind(id, account)
		.first();
	if (!mine) throw new PasskeyError(404, 'no such passkey');
	throw new PasskeyError(409, "that's your only passkey: add another before removing it");
}

export async function loginOptions(db: D1Database, config: AuthConfig, now = Date.now()) {
	// No allowCredentials: the browser offers whichever giggle passkey the listener has.
	const options = await generateAuthenticationOptions({
		rpID: config.rpID,
		userVerification: 'preferred'
	});
	const ticket = await saveChallenge(db, options.challenge, 'login', null, false, now);
	return { ticket, options };
}

export async function loginVerify(
	db: D1Database,
	config: AuthConfig,
	body: unknown,
	url: URL,
	now = Date.now()
): Promise<{ identity: Identity; cookie: string }> {
	const { ticket, response } = ticketed<AuthenticationResponseJSON>(body);
	const { challenge } = await takeChallenge(db, ticket, 'login', now);
	const row = await db
		.prepare('SELECT id, account, public_key, counter, transports FROM passkeys WHERE id = ?')
		.bind(String(response.id))
		.first<{
			id: string;
			account: string;
			public_key: ArrayBuffer;
			counter: number;
			transports: string;
		}>();
	if (!row) {
		throw new PasskeyError(401, "giggle doesn't know this passkey (was it removed?)");
	}
	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: config.origins,
			expectedRPID: config.rpID,
			requireUserVerification: false,
			credential: {
				id: row.id,
				publicKey: new Uint8Array(row.public_key),
				counter: row.counter,
				transports: JSON.parse(row.transports) as AuthenticatorTransport[]
			}
		});
	} catch (e) {
		throw new PasskeyError(401, `passkey not accepted: ${(e as Error).message}`);
	}
	if (!verification.verified) throw new PasskeyError(401, 'passkey not accepted');
	await db
		.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?')
		.bind(verification.authenticationInfo.newCounter, new Date(now).toISOString(), row.id)
		.run();
	const cookie = await startSession(db, row.account, url, now);
	return { identity: { user: row.account, via: 'passkey' }, cookie };
}
