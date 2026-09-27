// A software passkey authenticator for tests: P-256 keys from WebCrypto, "none" attestation, and
// real CBOR / authenticator data / DER signatures, so @simplewebauthn/server verifies genuine
// ceremonies. It is a synced (backed-up, multi-device) passkey with user verification.

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): number[] {
	if (n < 24) return [(major << 5) | n];
	if (n < 256) return [(major << 5) | 24, n];
	if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
	return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function cbor(value: Cbor): Uint8Array {
	const out: number[] = [];
	const put = (v: Cbor): void => {
		if (typeof v === 'number') out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
		else if (typeof v === 'string') {
			const bytes = new TextEncoder().encode(v);
			out.push(...head(3, bytes.length), ...bytes);
		} else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
		else if (Array.isArray(v)) {
			out.push(...head(4, v.length));
			v.forEach(put);
		} else {
			out.push(...head(5, v.size));
			for (const [k, x] of v) {
				put(k);
				put(x);
			}
		}
	};
	put(value);
	return new Uint8Array(out);
}

export function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
	const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

const sha256 = async (bytes: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** WebCrypto's raw r||s ECDSA signature as the DER WebAuthn expects. */
function der(raw: Uint8Array): Uint8Array {
	const int = (x: Uint8Array) => {
		let i = 0;
		while (i < x.length - 1 && x[i] === 0) i++;
		let v = x.slice(i);
		if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
		return concat(new Uint8Array([0x02, v.length]), v);
	};
	const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
	return concat(new Uint8Array([0x30, body.length]), body);
}

// UP (user present) | UV (verified) | BE (backup eligible) | BS (backed up)
const FLAGS = 0x01 | 0x04 | 0x08 | 0x10;
const AT = 0x40; // attested credential data follows

interface Stored {
	id: Uint8Array;
	keys: CryptoKeyPair;
	userHandle: string;
	counter: number;
}

export class SoftAuthenticator {
	readonly credentials: Stored[] = [];

	constructor(
		readonly origin = 'http://localhost:5173',
		readonly rpID = 'localhost'
	) {}

	async register(options: {
		challenge: string;
		user: { id: string };
		rp: { id?: string };
	}): Promise<Record<string, unknown>> {
		const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify'
		])) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
		const cose = cbor(
			new Map<number, Cbor>([
				[1, 2], // kty: EC2
				[3, -7], // alg: ES256
				[-1, 1], // crv: P-256
				[-2, fromB64url(jwk.x!)],
				[-3, fromB64url(jwk.y!)]
			])
		);
		const id = crypto.getRandomValues(new Uint8Array(16));
		const authData = concat(
			await sha256(new TextEncoder().encode(options.rp.id ?? this.rpID)),
			new Uint8Array([FLAGS | AT, 0, 0, 0, 0]),
			new Uint8Array(16), // AAGUID
			new Uint8Array([0, id.length]),
			id,
			cose
		);
		this.credentials.push({ id, keys, userHandle: options.user.id, counter: 0 });
		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: options.challenge,
			origin: this.origin,
			crossOrigin: false
		});
		return {
			id: b64url(id),
			rawId: b64url(id),
			type: 'public-key',
			authenticatorAttachment: 'platform',
			clientExtensionResults: {},
			response: {
				clientDataJSON: b64url(new TextEncoder().encode(clientData)),
				attestationObject: b64url(
					cbor(
						new Map<string, Cbor>([
							['fmt', 'none'],
							['attStmt', new Map()],
							['authData', authData]
						])
					)
				),
				transports: ['internal', 'hybrid']
			}
		};
	}

	async login(
		options: { challenge: string; rpId?: string },
		which = this.credentials[0]
	): Promise<Record<string, unknown>> {
		if (!which) throw new Error('no passkey to sign in with');
		const authData = concat(
			await sha256(new TextEncoder().encode(options.rpId ?? this.rpID)),
			new Uint8Array([FLAGS, 0, 0, 0, which.counter])
		);
		const clientData = new TextEncoder().encode(
			JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin })
		);
		const signed = concat(authData, await sha256(clientData));
		const raw = new Uint8Array(
			await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, which.keys.privateKey, signed)
		);
		return {
			id: b64url(which.id),
			rawId: b64url(which.id),
			type: 'public-key',
			authenticatorAttachment: 'platform',
			clientExtensionResults: {},
			response: {
				clientDataJSON: b64url(clientData),
				authenticatorData: b64url(authData),
				signature: b64url(der(raw)),
				userHandle: which.userHandle
			}
		};
	}
}
