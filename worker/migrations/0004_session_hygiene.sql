-- Tidying sessions and challenges (src/auth.ts, src/passkeys.ts): signing in deletes expired
-- sessions and all but the account's newest few, "sign out everywhere" deletes an account's
-- sessions, and starting a ceremony deletes expired challenges. These indexes keep each of those
-- from reading the whole table.
CREATE INDEX sessions_user ON sessions (user, created);
CREATE INDEX sessions_expires ON sessions (expires);
CREATE INDEX challenges_expires ON challenges (expires);
