'use strict';

const crypto = require('crypto');
const { Client } = require('@duosecurity/duo_universal');
const { AuthError } = require('./authService');

// How long a Duo challenge stays valid once started — long enough for
// someone to actually complete the prompt on their phone, short enough
// that an abandoned login attempt doesn't linger.
const PENDING_TTL_MS = 5 * 60 * 1000;

function hashState(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

// Builds a Duo client from environment variables, or returns null if Duo
// isn't configured — same dev-mode fallback as emailSender.js's
// RESEND_API_KEY: admin login just proceeds password-only rather than
// throwing, so npm test/local dev never need real Duo credentials.
function createDuoClient() {
  const { DUO_CLIENT_ID, DUO_CLIENT_SECRET, DUO_API_HOST, DUO_REDIRECT_URL } = process.env;
  if (!DUO_CLIENT_ID || !DUO_CLIENT_SECRET || !DUO_API_HOST || !DUO_REDIRECT_URL) {
    console.log('[duo:dev-mode] Duo env vars not fully set — admin logins will skip 2FA');
    return null;
  }
  return new Client({
    clientId: DUO_CLIENT_ID,
    clientSecret: DUO_CLIENT_SECRET,
    apiHost: DUO_API_HOST,
    redirectUrl: DUO_REDIRECT_URL,
  });
}

// Starts a Duo challenge for an admin who has already passed their
// password check. `origin` ('web' or 'app') is remembered so the callback
// — a top-level redirect from Duo's own domain, with no Origin header of
// its own to inspect — knows which cookie policy and which URL to hand
// control back to.
async function startDuoAuth(db, duoClient, { userId, username, origin }) {
  const state = duoClient.generateState();
  const stateHash = hashState(state);
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  db.prepare('INSERT INTO duo_pending (state_hash, user_id, origin, expires_at) VALUES (?, ?, ?, ?)')
    .run(stateHash, userId, origin, expiresAt);
  return duoClient.createAuthUrl(username, state);
}

// Confirms a Duo challenge from the callback redirect and returns who was
// logging in and from where. The pending row is deleted the moment it's
// read, success or failure, so a state can never be replayed.
async function completeDuoAuth(db, duoClient, { state, duoCode }) {
  if (!state || !duoCode) {
    throw new AuthError(400, 'Missing Duo state or code');
  }
  const stateHash = hashState(state);
  const pending = db.prepare('SELECT * FROM duo_pending WHERE state_hash = ?').get(stateHash);
  db.prepare('DELETE FROM duo_pending WHERE state_hash = ?').run(stateHash);
  if (!pending) {
    throw new AuthError(400, 'That Duo login attempt is invalid or has already been used');
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    throw new AuthError(400, 'That Duo login attempt has expired — log in again');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
  if (!user) {
    throw new AuthError(400, 'Account no longer exists');
  }
  try {
    await duoClient.exchangeAuthorizationCodeFor2FAResult(duoCode, user.email);
  } catch {
    throw new AuthError(401, 'Duo verification failed');
  }
  return { userId: pending.user_id, origin: pending.origin };
}

module.exports = { createDuoClient, startDuoAuth, completeDuoAuth };
