// Passkeys (WebAuthn) for signing in, via @simplewebauthn/server. No passwords, no email: an
// account is an id with one or more passkeys, and a passkey synced by the listener's password
// manager (iCloud, Google, 1Password…) signs them in on their other devices; a device without it
// can use the browser's "use a phone" QR flow.
//
//   POST /api/passkey/register/options  {}                  → {ticket, options}
//   POST /api/passkey/register/verify   {ticket, response}  → {user, via, created} (+ session
//                                                             cookie for a new account)
//   POST /api/passkey/login/options     {}                  → {ticket, options}
//   POST /api/passkey/login/verify      {ticket, response}  → {user, via} + session cookie
//   POST /api/passkey/reauth/options    {}                  → {ticket, options} (signed in)
//   POST /api/passkey/reauth/verify     {ticket, response}  → {ok}: the session is confirmed
//
// Registering while signed in with a passkey adds one to that account (a new device); otherwise it
// makes a new account (at most NEW_ACCOUNTS_PER_DAY a day, site-wide). Adding a passkey, removing
// one and deleting the account need the session confirmed by a passkey in the last few minutes
// (auth.ts isFresh): "reauth" does that with one of the account's own passkeys. Each ceremony's
// challenge is stored under a random ticket for five minutes and used once.

import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import {
	authenticate,
	confirmSession,
	isFresh,
	newToken,
	startSession,
	type Identity
} from './auth';
import type { AuthConfig } from './config';
import { dayOf, forgetUser } from './store';

export const PASSKEY_PREFIX = '/api/passkey/';
const CHALLENGE_MS = 5 * 60 * 1000;
/** Passkeys per account: plenty for a person's devices, not a way to fill the database. */
export const MAX_PASSKEYS = 20;
const RP_NAME = 'giggle';

type Purpose = 'register' | 'login' | 'reauth';

export class PasskeyError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** The session must be confirmed with a passkey first (reauth), then the request tried again. */
export class NeedsConfirmation extends PasskeyError {
	constructor() {
		super(403, 'confirm it’s you with your passkey first');
	}
}

/** Throws NeedsConfirmation unless a passkey confirmed `identity`'s session just now. */
export function requireFresh(identity: Identity, now = Date.now()): void {
	if (!isFresh(identity, now)) throw new NeedsConfirmation();
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
	purpose: Purpose,
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
	purpose: Purpose,
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

const NEW_ACCOUNTS = 'new-accounts';
const FULL_TODAY = "giggle isn't taking new accounts today: try again tomorrow";

// Takes one of today's `?3` new accounts, unless they're gone (then no row comes back).
const TAKE_QUOTA = `
INSERT INTO quotas (name, day, n) VALUES (?1, ?2, 1)
ON CONFLICT (name) DO UPDATE SET
  n = CASE WHEN quotas.day = excluded.day THEN quotas.n + 1 ELSE 1 END,
  day = excluded.day
WHERE quotas.day <> excluded.day OR quotas.n < ?3
RETURNING n`;

async function newAccountsLeft(db: D1Database, config: AuthConfig, now: number): Promise<boolean> {
	const row = await db
		.prepare('SELECT n FROM quotas WHERE name = ? AND day = ?')
		.bind(NEW_ACCOUNTS, dayOf(now))
		.first<{ n: number }>();
	return (row?.n ?? 0) < config.newAccountsPerDay;
}

async function takeNewAccount(db: D1Database, config: AuthConfig, now: number): Promise<void> {
	const taken =
		config.newAccountsPerDay > 0 &&
		(await db.prepare(TAKE_QUOTA).bind(NEW_ACCOUNTS, dayOf(now), config.newAccountsPerDay).first());
	if (!taken) throw new PasskeyError(429, FULL_TODAY);
}

export async function registerOptions(
	db: D1Database,
	config: AuthConfig,
	signedIn: Identity | null,
	now = Date.now()
) {
	// A passkey user adding a device joins their account; anyone else starts a new one.
	const existing = signedIn?.via === 'passkey';
	if (existing) requireFresh(signedIn, now);
	else if (!(await newAccountsLeft(db, config, now))) throw new PasskeyError(429, FULL_TODAY);
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

export interface Registered {
	identity: Identity;
	/** A new account (not a passkey added to the signed-in one). */
	created: boolean;
	/** Set-Cookie values: a session for a new account; none when adding a device. */
	cookies: string[];
}

export async function registerVerify(
	db: D1Database,
	config: AuthConfig,
	request: Request,
	body: unknown,
	now = Date.now()
): Promise<Registered> {
	const { ticket, response } = ticketed<RegistrationResponseJSON>(body);
	const { challenge, account, existing } = await takeChallenge(db, ticket, 'register', now);
	if (!account) throw new PasskeyError(400, 'bad ticket');
	if (existing) {
		// Still that account's session, and still recently confirmed.
		const auth = await authenticate(request, config, db);
		if (!auth.ok || auth.identity.user !== account) {
			throw new PasskeyError(401, 'sign in again to add a passkey');
		}
		requireFresh(auth.identity, now);
	}
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
		await takeNewAccount(db, config, now);
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
	const identity: Identity = { user: account, via: 'passkey' };
	// Adding a device keeps this browser's session; a new account starts one.
	if (existing) return { identity, created: false, cookies: [] };
	const cookies = await startSession(db, config, request, account, credential.id, now);
	return { identity, created: true, cookies };
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

/**
 * Removes one of the account's passkeys, never its last one (that would lock them out), and ends
 * the sessions it signed in (or last confirmed): a lost device's passkey takes its sessions with
 * it.
 */
export async function deletePasskey(db: D1Database, account: string, id: string): Promise<void> {
	const [removed] = await db.batch([
		db
			.prepare(
				`DELETE FROM passkeys WHERE id = ?1 AND account = ?2
				 AND (SELECT count(*) FROM passkeys WHERE account = ?2) > 1`
			)
			.bind(id, account),
		db
			.prepare(
				`DELETE FROM sessions WHERE passkey = ?1 AND user = ?2
				 AND NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?1)`
			)
			.bind(id, account)
	]);
	if (removed!.meta.changes) return;
	const mine = await db
		.prepare('SELECT 1 FROM passkeys WHERE id = ? AND account = ?')
		.bind(id, account)
		.first();
	if (!mine) throw new PasskeyError(404, 'no such passkey');
	throw new PasskeyError(409, "that's your only passkey: add another before removing it");
}

/**
 * Deletes `user`'s account and everything giggle keeps about it: synced data, passkeys,
 * sessions and unfinished ceremonies. (For the dev identity, which has no account, its data.)
 */
export async function deleteAccount(db: D1Database, user: string): Promise<void> {
	await db.batch([
		...forgetUser(db, user),
		db.prepare('DELETE FROM sessions WHERE user = ?').bind(user),
		db.prepare('DELETE FROM challenges WHERE account = ?').bind(user),
		db.prepare('DELETE FROM passkeys WHERE account = ?').bind(user),
		db.prepare('DELETE FROM accounts WHERE id = ?').bind(user)
	]);
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

/** Checks a passkey's signature over `challenge`; returns the passkey's id and account. */
async function checkAssertion(
	db: D1Database,
	config: AuthConfig,
	challenge: string,
	response: AuthenticationResponseJSON,
	now: number
): Promise<{ id: string; account: string }> {
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
	return { id: row.id, account: row.account };
}

export async function loginVerify(
	db: D1Database,
	config: AuthConfig,
	request: Request,
	body: unknown,
	now = Date.now()
): Promise<{ identity: Identity; cookies: string[] }> {
	const { ticket, response } = ticketed<AuthenticationResponseJSON>(body);
	const { challenge } = await takeChallenge(db, ticket, 'login', now);
	const passkey = await checkAssertion(db, config, challenge, response, now);
	const cookies = await startSession(db, config, request, passkey.account, passkey.id, now);
	return { identity: { user: passkey.account, via: 'passkey' }, cookies };
}

/** Options for confirming the signed-in session with one of the account's own passkeys. */
export async function reauthOptions(
	db: D1Database,
	config: AuthConfig,
	identity: Identity,
	now = Date.now()
) {
	if (identity.via !== 'passkey') throw new PasskeyError(400, 'no passkey to confirm with');
	const options = await generateAuthenticationOptions({
		rpID: config.rpID,
		userVerification: 'preferred',
		allowCredentials: await passkeysOf(db, identity.user)
	});
	const ticket = await saveChallenge(db, options.challenge, 'reauth', identity.user, true, now);
	return { ticket, options };
}

/** Confirms the signed-in session: the passkey must be one of that account's. */
export async function reauthVerify(
	db: D1Database,
	config: AuthConfig,
	identity: Identity,
	body: unknown,
	now = Date.now()
): Promise<void> {
	const { ticket, response } = ticketed<AuthenticationResponseJSON>(body);
	const { challenge, account } = await takeChallenge(db, ticket, 'reauth', now);
	if (!identity.session || account !== identity.user) {
		throw new PasskeyError(400, 'this confirmation was for another session: try again');
	}
	const passkey = await checkAssertion(db, config, challenge, response, now);
	if (passkey.account !== identity.user) {
		throw new PasskeyError(401, 'that passkey belongs to another giggle account');
	}
	await confirmSession(db, identity.session, passkey.id, now);
}
