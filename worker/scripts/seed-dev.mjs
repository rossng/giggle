#!/usr/bin/env node
// Fake accounts and 120 days of daily stats in the LOCAL dev D1 (worker/.wrangler/), so the admin
// panel (/admin, as the dev identity) has something to show: `make seed-dev`, after
// `make worker-migrate`. Always --local --env dev; there is no way to point it anywhere else.
//
// Seeded accounts are u_5eed…, with passkeys that can't sign in (no real key), sessions nobody
// holds and placeholder rows. Running it again replaces them; days of daily_stats that already
// have a row are left alone. `--clear` only removes them.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86_400_000;
const PREFIX = 'u_5eed';

// A fixed seed: the same fake site every time.
let state = 0x9e3779b9;
function random() {
	state = (state + 0x6d2b79f5) | 0;
	let t = Math.imul(state ^ (state >>> 15), 1 | state);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const hex = (n) => Array.from({ length: n }, () => between(0, 15).toString(16)).join('');
const q = (s) => (s === null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

const now = Date.now();
const day = (ago) => new Date(now - ago * DAY_MS).toISOString().slice(0, 10);
const stamp = (ago) => new Date(now - ago * DAY_MS - between(0, 86_000) * 1000).toISOString();
const today = day(0);

const clear = [
	`DELETE FROM sync_items WHERE user LIKE '${PREFIX}%'`,
	`DELETE FROM sync_counts WHERE user LIKE '${PREFIX}%'`,
	`DELETE FROM usage WHERE user LIKE '${PREFIX}%'`,
	`DELETE FROM sessions WHERE user LIKE '${PREFIX}%'`,
	`DELETE FROM passkeys WHERE account LIKE '${PREFIX}%'`,
	`DELETE FROM accounts WHERE id LIKE '${PREFIX}%'`
];

/** One account: when it signed up, came back, how much it keeps and wrote today. */
function account({
	ago,
	seenAgo,
	passkeys = 1,
	sessions = 1,
	board = 0,
	unavailable = 0,
	plays = 0,
	today: wrote = 0
}) {
	const id = `${PREFIX}${hex(4)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
	const sql = [
		`INSERT INTO accounts (id, created, last_seen) VALUES (${q(id)}, ${q(stamp(ago))}, ${q(seenAgo === null ? null : day(seenAgo))})`
	];
	for (let i = 0; i < passkeys; i++) {
		const used = seenAgo === null ? null : stamp(between(seenAgo, ago));
		sql.push(
			`INSERT INTO passkeys (id, account, public_key, counter, transports, device_type, backed_up, created, last_used) VALUES (${q(`seed-${hex(22)}`)}, ${q(id)}, X'00', 0, '["internal"]', 'multiDevice', 1, ${q(stamp(ago))}, ${q(used)})`
		);
	}
	for (let i = 0; i < sessions; i++) {
		sql.push(
			`INSERT INTO sessions (token_hash, user, created, expires, passkey, verified_at) VALUES (${q(`seed-${hex(40)}`)}, ${q(id)}, ${q(stamp(ago))}, ${q(new Date(now + 300 * DAY_MS).toISOString())}, NULL, NULL)`
		);
	}
	// Placeholder rows made in SQL: the board and plays are artist keys, unavailable are days.
	const rows = (collection, n, key, data) =>
		n &&
		sql.push(
			`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n})
			 INSERT INTO sync_items (user, collection, key, data, at, seq)
			 SELECT ${q(id)}, '${collection}', ${key}, ${data}, ${q(stamp(seenAgo ?? ago))}, i FROM k`
		);
	rows(
		'board',
		board,
		"'name:seed artist ' || i",
		`json_object('state', 'go', 'name', 'Seed Artist ' || i)`
	);
	rows('unavailable', unavailable, `date('${today}', '+' || i || ' days')`, "'{}'");
	rows('plays', plays, `'${stamp(1)} name:seed artist ' || i`, "'{}'");
	sql.push(
		`INSERT INTO sync_counts (user, collection, rows) SELECT user, collection, count(*) FROM sync_items WHERE user = ${q(id)} GROUP BY collection`
	);
	if (wrote)
		sql.push(`INSERT INTO usage (user, day, rows) VALUES (${q(id)}, ${q(today)}, ${wrote})`);
	return { ago, sql };
}

const accounts = [];
// Ordinary listeners, more of them lately.
for (let i = 0; i < 36; i++) {
	const ago = Math.floor(120 * random() ** 1.6);
	const gone = random() < 0.25;
	accounts.push(
		account({
			ago,
			seenAgo:
				random() < 0.05
					? null
					: gone
						? between(Math.min(ago, 30), ago)
						: between(0, Math.min(ago, 6)),
			passkeys: between(1, 3),
			sessions: between(1, 3),
			board: between(0, 250),
			unavailable: between(0, 8),
			plays: between(0, 600),
			today: random() < 0.4 ? between(1, 60) : 0
		})
	);
}
// Things the flags should catch: a board near its cap, most of today's writes and close to the
// daily budget, many passkeys and sessions, and a burst of empty sign-ups 40 days ago.
accounts.push(account({ ago: 90, seenAgo: 0, board: 17_500, plays: 900, today: 8_600 }));
accounts.push(account({ ago: 60, seenAgo: 1, passkeys: 14, sessions: 31, board: 40 }));
for (let i = 0; i < 50; i++) accounts.push(account({ ago: 40, seenAgo: 40 }));

// daily_stats as the Worker would have counted them: sign-ups from the accounts above, the rest
// made up (it's only numbers, no ids).
const signups = new Map();
for (const a of accounts) signups.set(day(a.ago), (signups.get(day(a.ago)) ?? 0) + 1);
const stats = [];
for (let ago = 120; ago >= 0; ago--) {
	const d = day(ago);
	const users = accounts.filter((a) => a.ago >= ago).length;
	const active = Math.round(
		Math.min(users, 4 + (36 * (120 - ago)) / 120) * (0.35 + 0.3 * random())
	);
	const written = active * between(5, 40) + (ago === 0 ? 8_600 : 0);
	const hits = ago === 40 ? 1 : ago === 12 ? 1 : 0;
	stats.push(
		`INSERT OR IGNORE INTO daily_stats (day, active_users, new_accounts, rows_written, quota_hits) VALUES (${q(d)}, ${active}, ${signups.get(d) ?? 0}, ${written}, ${hits})`
	);
}

const statements = process.argv.includes('--clear')
	? clear
	: [...clear, ...accounts.flatMap((a) => a.sql), ...stats];
const dir = mkdtempSync(join(tmpdir(), 'giggle-seed-'));
const file = join(dir, 'seed.sql');
writeFileSync(file, statements.map((s) => `${s.replace(/\s+/g, ' ').trim()};`).join('\n') + '\n');

const run = spawnSync(
	'pnpm',
	['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--env', 'dev', `--file=${file}`],
	{ cwd: WORKER, stdio: 'inherit' }
);
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(
	process.argv.includes('--clear')
		? 'Removed the seeded accounts.'
		: `Seeded ${accounts.length} accounts and ${stats.length} days. Open /admin as alice@example.test (make dev).`
);
