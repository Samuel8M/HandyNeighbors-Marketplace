'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const authSvc = require('../src/authService');
const { AuthError } = authSvc;

function freshDb() {
  return createDb(':memory:');
}

// A stand-in for real email delivery: records what would have been sent
// instead of calling out to a provider. authService hands this callback
// the raw token (building the full verify-email.html?token=... URL is
// server.js's job), so it's recorded as `token`, not a URL.
function fakeEmailSender() {
  const sent = [];
  const sender = async (email, token) => {
    sent.push({ email, token });
    return { sent: true, mode: 'fake' };
  };
  sender.sent = sent;
  return sender;
}

function baseSignup(overrides = {}) {
  return {
    email: 'jordan@example.com',
    password: 'correct horse battery staple',
    name: 'Jordan Reyes',
    acceptedTerms: true,
    ...overrides,
  };
}

test('signup creates an account, a session, and sends a verification email', async () => {
  const db = freshDb();
  const emailSender = fakeEmailSender();
  const { user, session, verification } = await authSvc.signup(db, baseSignup(), emailSender);

  assert.equal(user.email, 'jordan@example.com');
  assert.equal(user.name, 'Jordan Reyes');
  assert.equal(user.emailVerified, false);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(emailSender.sent.length, 1);
  assert.equal(emailSender.sent[0].email, 'jordan@example.com');
  assert.equal(verification.sent, true);
});

test('signup requires acceptedTerms', async () => {
  const db = freshDb();
  await assert.rejects(
    () => authSvc.signup(db, baseSignup({ acceptedTerms: false }), fakeEmailSender()),
    (err) => err instanceof AuthError && err.status === 400 && /Terms of Service/.test(err.message)
  );
});

test('signup rejects a short password', async () => {
  const db = freshDb();
  await assert.rejects(
    () => authSvc.signup(db, baseSignup({ password: 'short' }), fakeEmailSender()),
    (err) => err instanceof AuthError && err.status === 400
  );
});

test('signup rejects an invalid email', async () => {
  const db = freshDb();
  await assert.rejects(
    () => authSvc.signup(db, baseSignup({ email: 'not-an-email' }), fakeEmailSender()),
    (err) => err instanceof AuthError && err.status === 400
  );
});

test('signup rejects a duplicate email', async () => {
  const db = freshDb();
  await authSvc.signup(db, baseSignup(), fakeEmailSender());
  await assert.rejects(
    () => authSvc.signup(db, baseSignup({ name: 'Someone Else' }), fakeEmailSender()),
    (err) => err instanceof AuthError && err.status === 409
  );
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  const db = freshDb();
  await authSvc.signup(db, baseSignup(), fakeEmailSender());

  const { user, session } = authSvc.login(db, { email: 'jordan@example.com', password: 'correct horse battery staple' });
  assert.equal(user.email, 'jordan@example.com');
  assert.match(session.token, /^[a-f0-9]{64}$/);

  assert.throws(
    () => authSvc.login(db, { email: 'jordan@example.com', password: 'wrong password' }),
    (err) => err instanceof AuthError && err.status === 401
  );
});

test('login fails for an unknown email with the same message as a wrong password', async () => {
  const db = freshDb();
  await authSvc.signup(db, baseSignup(), fakeEmailSender());

  let unknownEmailError;
  try {
    authSvc.login(db, { email: 'nobody@example.com', password: 'whatever12345' });
  } catch (err) {
    unknownEmailError = err;
  }
  let wrongPasswordError;
  try {
    authSvc.login(db, { email: 'jordan@example.com', password: 'whatever12345' });
  } catch (err) {
    wrongPasswordError = err;
  }
  assert.equal(unknownEmailError.message, wrongPasswordError.message);
});

test('resolveSession returns the user for a valid session and null otherwise', async () => {
  const db = freshDb();
  const { session } = await authSvc.signup(db, baseSignup(), fakeEmailSender());

  const resolved = authSvc.resolveSession(db, session.token);
  assert.equal(resolved.email, 'jordan@example.com');

  assert.equal(authSvc.resolveSession(db, 'not-a-real-token'), null);
  assert.equal(authSvc.resolveSession(db, undefined), null);
});

test('destroySession logs the session out', async () => {
  const db = freshDb();
  const { session } = await authSvc.signup(db, baseSignup(), fakeEmailSender());

  authSvc.destroySession(db, session.token);
  assert.equal(authSvc.resolveSession(db, session.token), null);
});

test('verifyEmail marks the account verified and consumes the token', async () => {
  const db = freshDb();
  const emailSender = fakeEmailSender();
  await authSvc.signup(db, baseSignup(), emailSender);
  const token = emailSender.sent[0].token;

  const user = authSvc.verifyEmail(db, token);
  assert.equal(user.emailVerified, true);

  assert.throws(
    () => authSvc.verifyEmail(db, token),
    (err) => err instanceof AuthError && err.status === 400
  );
});

test('verifyEmail rejects a bogus token', async () => {
  const db = freshDb();
  assert.throws(
    () => authSvc.verifyEmail(db, 'not-a-real-token'),
    (err) => err instanceof AuthError && err.status === 400
  );
});

test('deleteAccount removes the account and logs out its sessions', async () => {
  const db = freshDb();
  const { user, session } = await authSvc.signup(db, baseSignup(), fakeEmailSender());

  authSvc.deleteAccount(db, user.id);

  assert.equal(authSvc.resolveSession(db, session.token), null);
  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(user.id), undefined);
});

test('resendVerification issues a fresh token and rejects an already-verified account', async () => {
  const db = freshDb();
  const emailSender = fakeEmailSender();
  const { user } = await authSvc.signup(db, baseSignup(), emailSender);

  await authSvc.resendVerification(db, user.id, emailSender);
  assert.equal(emailSender.sent.length, 2);
  assert.notEqual(emailSender.sent[0].token, emailSender.sent[1].token);

  authSvc.verifyEmail(db, emailSender.sent[1].token);

  await assert.rejects(
    () => authSvc.resendVerification(db, user.id, emailSender),
    (err) => err instanceof AuthError && err.status === 400
  );
});
