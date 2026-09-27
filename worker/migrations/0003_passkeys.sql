-- Signing in with passkeys (src/passkeys.ts, src/auth.ts). An account is just an id with one or
-- more passkeys; its synced data lives in sync_items under that id ("u_<uuid>").
CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	created TEXT NOT NULL
) WITHOUT ROWID;

-- WebAuthn credentials. The id is the credential id (base64url), the public key its COSE bytes.
CREATE TABLE passkeys (
	id TEXT PRIMARY KEY,
	account TEXT NOT NULL REFERENCES accounts (id),
	public_key BLOB NOT NULL,
	-- The authenticator's signature counter (0 for most passkeys, which don't count).
	counter INTEGER NOT NULL,
	-- JSON array of transports ("internal", "hybrid", …), for signing in on other devices.
	transports TEXT NOT NULL,
	-- 'multiDevice' for synced passkeys (iCloud, Google, 1Password), 'singleDevice' otherwise.
	device_type TEXT NOT NULL,
	backed_up INTEGER NOT NULL,
	created TEXT NOT NULL,
	last_used TEXT
) WITHOUT ROWID;

CREATE INDEX passkeys_account ON passkeys (account);

-- Signed-in browsers. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	user TEXT NOT NULL,
	created TEXT NOT NULL,
	expires TEXT NOT NULL
) WITHOUT ROWID;

-- A ceremony in progress: the challenge the browser must sign, for a few minutes, used once.
CREATE TABLE challenges (
	id TEXT PRIMARY KEY,
	challenge TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
	-- register: the account the new passkey joins (new or the signed-in one).
	account TEXT,
	-- register: whether that account already exists.
	existing INTEGER NOT NULL DEFAULT 0,
	expires TEXT NOT NULL
) WITHOUT ROWID;
