'use strict';

const crypto = require('crypto');

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokensMatch(hashA, hashB) {
  const a = Buffer.from(hashA, 'hex');
  const b = Buffer.from(hashB, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// scrypt, not bcrypt/argon2: it's in Node's own `crypto` module, so hashing
// passwords needs zero extra dependencies. Format is 'scrypt:<saltHex>:
// <derivedKeyHex>' — self-describing, so the scheme can change later
// without invalidating existing hashes.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cleanEmail(email) {
  const trimmed = String(email || '').trim().toLowerCase();
  if (trimmed.length > 200 || !EMAIL_RE.test(trimmed)) {
    throw new AuthError(400, 'Enter a valid email address');
  }
  return trimmed;
}

function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: !!row.email_verified,
    memberSince: row.created_at,
    isAdmin: !!row.is_admin,
    bannedAt: row.banned_at || null,
  };
}

// Grants admin on the fly to any account whose email is listed in the
// ADMIN_EMAILS env var (comma-separated, case-insensitive) — there's no API
// path that sets is_admin, so this is the only way an account becomes an
// admin. Runs on every session resolution/login, so listing (or removing)
// an address there takes effect the next time that person is seen, no
// matter whether their account already existed.
function syncAdminFlag(db, row) {
  if (row.is_admin) return row;
  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.includes(row.email)) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(row.id);
    row.is_admin = 1;
  }
  return row;
}

function getPublicUser(db, userId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return row ? toPublicUser(syncAdminFlag(db, row)) : null;
}

function createSession(db, userId) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  return { token, expiresAt };
}

/**
 * Looks up the user behind a session cookie value. Returns null (never
 * throws) for a missing, unknown, or expired session — callers treat "no
 * user" as the normal logged-out state, not an error.
 */
function resolveSession(db, sessionToken) {
  if (!sessionToken) return null;
  const tokenHash = hashToken(sessionToken);
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;
  if (new Date(row.session_expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return toPublicUser(syncAdminFlag(db, row));
}

function destroySession(db, sessionToken) {
  if (!sessionToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sessionToken));
}

/**
 * Signs up a new account. Requires acceptedTerms — this is the app's
 * record that the user agreed to the Terms of Service and Privacy Policy,
 * timestamped (accepted_terms_at), the way a checkbox-at-signup is
 * expected to be provable later.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{email: string, password: string, name: string, acceptedTerms: boolean}} input
 * @param {(email: string, token: string) => Promise<object>} sendVerificationEmail
 */
async function signup(db, input, sendVerificationEmail) {
  if (input.acceptedTerms !== true) {
    throw new AuthError(400, 'You must accept the Terms of Service and Privacy Policy to create an account');
  }
  const email = cleanEmail(input.email);
  const name = String(input.name || '').trim();
  if (name.length < 1 || name.length > 80) {
    throw new AuthError(400, 'Name is required (1-80 characters)');
  }
  const password = input.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new AuthError(400, 'Password must be at least 8 characters');
  }

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw new AuthError(409, 'An account with that email already exists');
  }

  const passwordHash = hashPassword(password);
  const verificationToken = generateToken();
  const verificationTokenHash = hashToken(verificationToken);
  const now = new Date().toISOString();

  const info = db.prepare(`
    INSERT INTO users (email, password_hash, name, verification_token_hash, verification_sent_at, accepted_terms_at)
    VALUES (@email, @passwordHash, @name, @verificationTokenHash, @now, @now)
  `).run({ email, passwordHash, name, verificationTokenHash, now });

  const userId = Number(info.lastInsertRowid);
  const verification = await sendVerificationEmail(email, verificationToken);
  const session = createSession(db, userId);

  return { user: getPublicUser(db, userId), session, verification };
}

function login(db, { email, password }) {
  const cleanedEmail = cleanEmail(email);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanedEmail);
  // Same "incorrect email or password" message either way — confirming
  // which part was wrong would let someone enumerate registered emails.
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) {
    throw new AuthError(401, 'Incorrect email or password');
  }
  const session = createSession(db, row.id);
  return { user: toPublicUser(syncAdminFlag(db, row)), session };
}

async function resendVerification(db, userId, sendVerificationEmail) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new AuthError(404, 'Account not found');
  if (row.email_verified) throw new AuthError(400, 'This account is already verified');

  const token = generateToken();
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET verification_token_hash = ?, verification_sent_at = ? WHERE id = ?').run(tokenHash, now, userId);
  return sendVerificationEmail(row.email, token);
}

function verifyEmail(db, token) {
  if (!token) throw new AuthError(400, 'Missing verification token');
  const tokenHash = hashToken(String(token));
  const row = db.prepare('SELECT * FROM users WHERE verification_token_hash = ?').get(tokenHash);
  if (!row) throw new AuthError(400, 'That verification link is invalid or has already been used');

  const sentAt = new Date(row.verification_sent_at).getTime();
  if (Date.now() - sentAt > VERIFICATION_TTL_MS) {
    throw new AuthError(400, 'That verification link has expired — request a new one from your account');
  }

  db.prepare('UPDATE users SET email_verified = 1, verification_token_hash = NULL WHERE id = ?').run(row.id);
  return getPublicUser(db, row.id);
}

// Every table that references a user (sessions, workers, reviews) does so
// with ON DELETE CASCADE, so removing the account also removes their
// listings, reviews, and active sessions in one go — the right-to-erasure
// mechanism described in the Privacy Policy.
function deleteAccount(db, userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

module.exports = {
  AuthError,
  deleteAccount,
  signup,
  login,
  resolveSession,
  destroySession,
  verifyEmail,
  resendVerification,
  getPublicUser,
  // exported for tests / for server.js's cookie plumbing
  generateToken,
  hashToken,
  tokensMatch,
  hashPassword,
  verifyPassword,
};
