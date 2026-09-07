'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createApp } = require('../src/server');

// A stand-in for real email delivery, injected into createApp() so tests
// never depend on network access or a real provider — see
// src/emailSender.js for what actually ships in production.
function fakeEmailSender() {
  const sent = [];
  const sender = async (email, verifyUrl) => {
    sent.push({ email, verifyUrl });
    return { sent: true, mode: 'fake', verifyUrl };
  };
  sender.sent = sent;
  return sender;
}

function startServer(options = {}) {
  const db = createDb(':memory:');
  const sendVerificationEmail = fakeEmailSender();
  const app = createApp(db, { sendVerificationEmail, ...options });
  const server = app.listen(0);
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}`, sendVerificationEmail };
}

// A stand-in for @duosecurity/duo_universal's Client, injected into
// createApp() the same way fakeEmailSender() is — see duoService.js.
// exchangeAuthorizationCodeFor2FAResult only succeeds for 'good-code',
// mirroring how the real SDK rejects a wrong/tampered code.
function fakeDuoClient() {
  let counter = 0;
  return {
    calls: { createAuthUrl: 0, exchange: 0 },
    generateState() {
      counter += 1;
      return `state-${counter}`;
    },
    async createAuthUrl(username, state) {
      this.calls.createAuthUrl += 1;
      return `https://fake-duo.example/prompt?username=${encodeURIComponent(username)}&state=${state}`;
    },
    async exchangeAuthorizationCodeFor2FAResult(duoCode) {
      this.calls.exchange += 1;
      if (duoCode !== 'good-code') throw new Error('bad code');
      return { auth_result: { status: 'allow' } };
    },
  };
}

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : null;
}

async function request(baseUrl, method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json, cookie: extractCookie(res) };
}

function signupPayload(overrides = {}) {
  return {
    email: `user-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'correct horse battery staple',
    name: 'Jordan Reyes',
    acceptedTerms: true,
    ...overrides,
  };
}

function workerPayload(overrides = {}) {
  return {
    name: 'Jordan Reyes',
    bio: 'Ten years fixing everything that squeaks.',
    hourlyRate: 45,
    city: 'Pittsburgh',
    state: 'PA',
    contactEmail: 'jordan@example.com',
    skills: ['drywall-repair', 'painting'],
    equipment: ['ladder'],
    ...overrides,
  };
}

// Signs up, verifies the account via the emailed link, and returns the
// session cookie plus the user — the common setup every worker/review
// test needs, since posting and reviewing both require verification.
async function signUpAndVerify(baseUrl, sendVerificationEmail, overrides = {}) {
  const signup = await request(baseUrl, 'POST', '/api/auth/signup', { body: signupPayload(overrides) });
  assert.equal(signup.status, 201);
  const verifyUrl = signup.body.verification.verifyUrl;
  const token = new URL(verifyUrl).searchParams.get('token');
  const verify = await request(baseUrl, 'GET', `/api/auth/verify-email?token=${token}`);
  assert.equal(verify.status, 200);
  return { cookie: signup.cookie, user: verify.body.user };
}

test('GET /health returns ok', async () => {
  const { server, baseUrl } = startServer();
  try {
    const { status, body } = await request(baseUrl, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  } finally {
    server.close();
  }
});

test('GET /.well-known/assetlinks.json is served (Android app link verification)', async () => {
  const { server, baseUrl } = startServer();
  try {
    const { status, body } = await request(baseUrl, 'GET', '/.well-known/assetlinks.json');
    assert.equal(status, 200);
    assert.equal(body[0].target.package_name, 'com.handyneighbors.app');
  } finally {
    server.close();
  }
});

test('GET /api/skills and /api/equipment return seeded lists', async () => {
  const { server, baseUrl } = startServer();
  try {
    const skills = await request(baseUrl, 'GET', '/api/skills');
    assert.equal(skills.status, 200);
    assert.ok(skills.body.some((s) => s.slug === 'drywall-repair'));

    const equipment = await request(baseUrl, 'GET', '/api/equipment');
    assert.equal(equipment.status, 200);
    assert.ok(equipment.body.some((e) => e.slug === 'ladder'));
  } finally {
    server.close();
  }
});

test('signup, verify, and login flow', async () => {
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const payload = signupPayload();
    const signup = await request(baseUrl, 'POST', '/api/auth/signup', { body: payload });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.user.email, payload.email);
    assert.equal(signup.body.user.emailVerified, false);
    assert.ok(signup.cookie, 'signup should set a session cookie');
    assert.equal(sendVerificationEmail.sent.length, 1);

    // Duplicate signup is rejected.
    const dupe = await request(baseUrl, 'POST', '/api/auth/signup', { body: payload });
    assert.equal(dupe.status, 409);

    // /me reflects the signed-in (but not yet verified) user.
    const me = await request(baseUrl, 'GET', '/api/auth/me', { cookie: signup.cookie });
    assert.equal(me.body.user.email, payload.email);

    // Verify via the link the "email" carried.
    const token = new URL(sendVerificationEmail.sent[0].verifyUrl).searchParams.get('token');
    const verify = await request(baseUrl, 'GET', `/api/auth/verify-email?token=${token}`);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.user.emailVerified, true);

    // Now login independently works.
    const login = await request(baseUrl, 'POST', '/api/auth/login', {
      body: { email: payload.email, password: payload.password },
    });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);

    const wrongPassword = await request(baseUrl, 'POST', '/api/auth/login', {
      body: { email: payload.email, password: 'nope nope nope' },
    });
    assert.equal(wrongPassword.status, 401);

    // Logout clears the session.
    const logout = await request(baseUrl, 'POST', '/api/auth/logout', { cookie: login.cookie });
    assert.equal(logout.status, 204);
    const meAfterLogout = await request(baseUrl, 'GET', '/api/auth/me', { cookie: login.cookie });
    assert.equal(meAfterLogout.body.user, null);
  } finally {
    server.close();
  }
});

test('POST /api/workers requires auth, then requires a verified email', async () => {
  const { server, baseUrl } = startServer();
  try {
    const anon = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload() });
    assert.equal(anon.status, 401);

    const signup = await request(baseUrl, 'POST', '/api/auth/signup', { body: signupPayload() });
    const unverified = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload(), cookie: signup.cookie });
    assert.equal(unverified.status, 403);
  } finally {
    server.close();
  }
});

test('full worker lifecycle: create, search, price-check, review, update, delete — ownership enforced throughout', async () => {
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const owner = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Owner Olive' });

    const created = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload(), cookie: owner.cookie });
    assert.equal(created.status, 201);
    const worker = created.body.worker;
    assert.equal(worker.ownerId, owner.user.id);
    assert.equal(worker.verified, true);

    const fetched = await request(baseUrl, 'GET', `/api/workers/${worker.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.name, 'Jordan Reyes');

    const search = await request(baseUrl, 'GET', '/api/workers?skill=painting&city=Pittsburgh&state=PA');
    assert.equal(search.status, 200);
    assert.equal(search.body.length, 1);

    const priceCheck = await request(baseUrl, 'GET', '/api/price-check?skill=painting');
    assert.equal(priceCheck.status, 200);
    assert.equal(priceCheck.body.count, 1);
    assert.equal(priceCheck.body.average, 45);

    // Owner can't review their own listing.
    const selfReview = await request(baseUrl, 'POST', `/api/workers/${worker.id}/reviews`, {
      body: { rating: 5 }, cookie: owner.cookie,
    });
    assert.equal(selfReview.status, 400);

    const reviewer = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Sam' });
    const review = await request(baseUrl, 'POST', `/api/workers/${worker.id}/reviews`, {
      body: { rating: 5, comment: 'Fixed my sink fast.' }, cookie: reviewer.cookie,
    });
    assert.equal(review.status, 201);
    assert.equal(review.body.authorName, 'Sam');

    // A second review from the same reviewer is rejected.
    const dupeReview = await request(baseUrl, 'POST', `/api/workers/${worker.id}/reviews`, {
      body: { rating: 1 }, cookie: reviewer.cookie,
    });
    assert.equal(dupeReview.status, 409);

    const reviews = await request(baseUrl, 'GET', `/api/workers/${worker.id}/reviews`);
    assert.equal(reviews.body.length, 1);

    // Someone else can't edit or delete the listing.
    const badUpdate = await request(baseUrl, 'PUT', `/api/workers/${worker.id}`, {
      body: workerPayload({ hourlyRate: 60 }), cookie: reviewer.cookie,
    });
    assert.equal(badUpdate.status, 403);
    const badDelete = await request(baseUrl, 'DELETE', `/api/workers/${worker.id}`, { cookie: reviewer.cookie });
    assert.equal(badDelete.status, 403);

    // The owner can.
    const update = await request(baseUrl, 'PUT', `/api/workers/${worker.id}`, {
      body: workerPayload({ hourlyRate: 60 }), cookie: owner.cookie,
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.hourlyRate, 60);

    const del = await request(baseUrl, 'DELETE', `/api/workers/${worker.id}`, { cookie: owner.cookie });
    assert.equal(del.status, 204);

    const gone = await request(baseUrl, 'GET', `/api/workers/${worker.id}`);
    assert.equal(gone.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/workers returns 400 for invalid input once verified', async () => {
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const owner = await signUpAndVerify(baseUrl, sendVerificationEmail);
    const { status, body } = await request(baseUrl, 'POST', '/api/workers', {
      body: workerPayload({ skills: [] }), cookie: owner.cookie,
    });
    assert.equal(status, 400);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('DELETE /api/auth/me deletes the account and cascades to their listings', async () => {
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const owner = await signUpAndVerify(baseUrl, sendVerificationEmail);
    const created = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload(), cookie: owner.cookie });
    const workerId = created.body.worker.id;

    const del = await request(baseUrl, 'DELETE', '/api/auth/me', { cookie: owner.cookie });
    assert.equal(del.status, 204);

    const gone = await request(baseUrl, 'GET', `/api/workers/${workerId}`);
    assert.equal(gone.status, 404);

    const me = await request(baseUrl, 'GET', '/api/auth/me', { cookie: owner.cookie });
    assert.equal(me.body.user, null);
  } finally {
    server.close();
  }
});

test('reporting a listing: requires a verified account, blocks self-reports, and is admin-visible', async () => {
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const owner = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Owner Olive' });
    const created = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload(), cookie: owner.cookie });
    const workerId = created.body.worker.id;

    const anon = await request(baseUrl, 'POST', '/api/reports', {
      body: { targetType: 'worker', targetId: workerId, reason: 'spam' },
    });
    assert.equal(anon.status, 401);

    const selfReport = await request(baseUrl, 'POST', '/api/reports', {
      body: { targetType: 'worker', targetId: workerId, reason: 'spam' }, cookie: owner.cookie,
    });
    assert.equal(selfReport.status, 400);

    const reporter = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Reporter Rae' });
    const report = await request(baseUrl, 'POST', '/api/reports', {
      body: { targetType: 'worker', targetId: workerId, reason: 'inappropriate_content', details: 'Not cool' },
      cookie: reporter.cookie,
    });
    assert.equal(report.status, 201);
    assert.equal(report.body.status, 'open');

    // Not an admin: the queue is invisible to them.
    const deniedList = await request(baseUrl, 'GET', '/api/admin/reports', { cookie: reporter.cookie });
    assert.equal(deniedList.status, 403);
  } finally {
    server.close();
  }
});

test('admin routes: gated by ADMIN_EMAILS, and acting on a report can ban the listing owner', async () => {
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const ownerPayload = signupPayload({ name: 'Owner Olive' });
    process.env.ADMIN_EMAILS = ''; // owner signs up as a regular user first
    const ownerSignup = await request(baseUrl, 'POST', '/api/auth/signup', { body: ownerPayload });
    const ownerVerify = await request(baseUrl, 'GET', `/api/auth/verify-email?token=${new URL(ownerSignup.body.verification.verifyUrl).searchParams.get('token')}`);
    const owner = { cookie: ownerSignup.cookie, user: ownerVerify.body.user };
    const created = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload(), cookie: owner.cookie });
    const workerId = created.body.worker.id;

    const adminPayload = signupPayload({ name: 'Admin Andy' });
    process.env.ADMIN_EMAILS = adminPayload.email; // granted the moment they sign up
    const adminSignup = await request(baseUrl, 'POST', '/api/auth/signup', { body: adminPayload });
    assert.equal(adminSignup.body.user.isAdmin, true);
    const adminCookie = adminSignup.cookie;

    const reporter = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Reporter Rae' });
    const report = await request(baseUrl, 'POST', '/api/reports', {
      body: { targetType: 'worker', targetId: workerId, reason: 'scam_or_fraud' }, cookie: reporter.cookie,
    });

    const list = await request(baseUrl, 'GET', '/api/admin/reports?status=open', { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const action = await request(baseUrl, 'POST', `/api/admin/reports/${report.body.id}/action`, {
      body: { action: 'ban_user' }, cookie: adminCookie,
    });
    assert.equal(action.status, 200);
    assert.equal(action.body.status, 'actioned');

    // The banned owner can no longer post a new listing…
    const blockedPost = await request(baseUrl, 'POST', '/api/workers', {
      body: workerPayload({ name: 'Second listing' }), cookie: owner.cookie,
    });
    assert.equal(blockedPost.status, 403);

    // …until an admin unbans them.
    const bannedList = await request(baseUrl, 'GET', '/api/admin/banned-users', { cookie: adminCookie });
    assert.equal(bannedList.body.length, 1);
    const unban = await request(baseUrl, 'POST', `/api/admin/banned-users/${bannedList.body[0].id}/unban`, { cookie: adminCookie });
    assert.equal(unban.status, 204);

    const allowedPost = await request(baseUrl, 'POST', '/api/workers', {
      body: workerPayload({ name: 'Second listing' }), cookie: owner.cookie,
    });
    assert.equal(allowedPost.status, 201);
  } finally {
    process.env.ADMIN_EMAILS = previousAdminEmails;
    server.close();
  }
});

test('customer ratings: a worker can rate back a reviewer, but only once, and /api/auth/me reflects it', async () => {
  const { server, baseUrl, sendVerificationEmail } = startServer();
  try {
    const owner = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Owner Olive' });
    const created = await request(baseUrl, 'POST', '/api/workers', { body: workerPayload(), cookie: owner.cookie });
    const workerId = created.body.worker.id;

    const customer = await signUpAndVerify(baseUrl, sendVerificationEmail, { name: 'Customer Cam' });

    // Can't rate before any review links them.
    const tooSoon = await request(baseUrl, 'POST', `/api/users/${customer.user.id}/rate`, {
      body: { rating: 5 }, cookie: owner.cookie,
    });
    assert.equal(tooSoon.status, 403);

    await request(baseUrl, 'POST', `/api/workers/${workerId}/reviews`, {
      body: { rating: 5, comment: 'Great work' }, cookie: customer.cookie,
    });

    const rated = await request(baseUrl, 'POST', `/api/users/${customer.user.id}/rate`, {
      body: { rating: 4, comment: 'Easy to work with' }, cookie: owner.cookie,
    });
    assert.equal(rated.status, 201);

    const dupe = await request(baseUrl, 'POST', `/api/users/${customer.user.id}/rate`, {
      body: { rating: 3 }, cookie: owner.cookie,
    });
    assert.equal(dupe.status, 409);

    const summary = await request(baseUrl, 'GET', `/api/users/${customer.user.id}/rating`);
    assert.deepEqual(summary.body, { average: 4, count: 1 });

    const me = await request(baseUrl, 'GET', '/api/auth/me', { cookie: customer.cookie });
    assert.deepEqual(me.body.user.customerRating, { average: 4, count: 1 });
  } finally {
    server.close();
  }
});

test('login is rate-limited after repeated attempts', async () => {
  const { server, baseUrl } = startServer();
  try {
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await request(baseUrl, 'POST', '/api/auth/login', {
        body: { email: 'nobody@example.com', password: 'wrong' },
      });
    }
    assert.equal(last.status, 429);
  } finally {
    server.close();
  }
});

// Admins carry moderation/ban power, so — unlike everyone else — their
// login goes through Duo 2FA once it's configured (duoClient injected
// here the same way sendVerificationEmail is). Covers both the website
// (Lax cookie, redirect to '/') and the bundled Android app (None+Secure
// cookie, redirect to https://localhost) — see duoService.js/server.js.
test('admin login requires Duo 2FA; everyone else is unaffected', async () => {
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  const duo = fakeDuoClient();
  const { server, baseUrl } = startServer({ duoClient: duo });
  try {
    const adminPayload = signupPayload({ name: 'Admin Andy' });
    process.env.ADMIN_EMAILS = adminPayload.email;
    await request(baseUrl, 'POST', '/api/auth/signup', { body: adminPayload });

    // Website login: password check succeeds, but it's a Duo redirect,
    // not a completed session.
    const webLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminPayload.email, password: adminPayload.password }),
    });
    const webBody = await webLogin.json();
    assert.ok(webBody.duoRedirectUrl);
    assert.equal(webLogin.headers.get('set-cookie'), null);
    const webState = new URL(webBody.duoRedirectUrl).searchParams.get('state');

    // Duo redirects back with the wrong code: rejected, no cookie.
    const badCallback = await fetch(`${baseUrl}/api/auth/duo/callback?state=${webState}&duo_code=wrong-code`, { redirect: 'manual' });
    assert.equal(badCallback.status, 401);

    // Right code, but the state was already consumed by the attempt above
    // (one-time use regardless of outcome) — still rejected.
    const reusedState = await fetch(`${baseUrl}/api/auth/duo/callback?state=${webState}&duo_code=good-code`, { redirect: 'manual' });
    assert.equal(reusedState.status, 400);

    // A fresh attempt, completed correctly this time: Lax cookie, redirect to '/'.
    const webLogin2 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminPayload.email, password: adminPayload.password }),
    });
    const webState2 = new URL((await webLogin2.json()).duoRedirectUrl).searchParams.get('state');
    const webCallback = await fetch(`${baseUrl}/api/auth/duo/callback?state=${webState2}&duo_code=good-code`, { redirect: 'manual' });
    assert.equal(webCallback.status, 302);
    assert.equal(webCallback.headers.get('location'), '/?source=duo#find');
    assert.match(webCallback.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.doesNotMatch(webCallback.headers.get('set-cookie'), /SameSite=None/i);

    // Same dance from the bundled app's origin: None+Secure cookie,
    // redirect back to the local app shell instead of the live website.
    const appLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://localhost' },
      body: JSON.stringify({ email: adminPayload.email, password: adminPayload.password }),
    });
    const appState = new URL((await appLogin.json()).duoRedirectUrl).searchParams.get('state');
    const appCallback = await fetch(`${baseUrl}/api/auth/duo/callback?state=${appState}&duo_code=good-code`, { redirect: 'manual' });
    assert.equal(appCallback.status, 302);
    assert.equal(appCallback.headers.get('location'), 'https://localhost/?source=duo#find');
    assert.match(appCallback.headers.get('set-cookie'), /SameSite=None/i);
    assert.match(appCallback.headers.get('set-cookie'), /Secure/i);

    assert.equal(duo.calls.createAuthUrl, 3);
    assert.equal(duo.calls.exchange, 3);

    // A regular (non-admin) login never touches Duo at all.
    const regularPayload = signupPayload({ name: 'Regular Rae' });
    await request(baseUrl, 'POST', '/api/auth/signup', { body: regularPayload });
    const regularLogin = await request(baseUrl, 'POST', '/api/auth/login', {
      body: { email: regularPayload.email, password: regularPayload.password },
    });
    assert.equal(regularLogin.body.duoRedirectUrl, undefined);
    assert.ok(regularLogin.cookie);
    assert.equal(duo.calls.createAuthUrl, 3);
    assert.equal(duo.calls.exchange, 3);
  } finally {
    process.env.ADMIN_EMAILS = previousAdminEmails;
    server.close();
  }
});

// The bundled Android app talks to this same API cross-origin (from
// https://localhost), so it needs an explicit CORS allowance and a cookie
// willing to travel cross-site — while the plain website (no Origin header)
// must see byte-identical behavior to before that support existed.
test('CORS and session cookie attributes depend on the request Origin', async () => {
  const { server, baseUrl } = startServer();
  try {
    const login = (origin) => fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
    });

    // No Origin header at all (a plain website visit): no CORS headers, and
    // the failed-login response obviously carries no cookie either way —
    // this is the "existing browser users are unaffected" regression guard.
    const plain = await login();
    assert.equal(plain.headers.get('access-control-allow-origin'), null);
    assert.equal(plain.headers.get('access-control-allow-credentials'), null);

    // An origin nobody allow-listed: also nothing, reject-by-default.
    const untrusted = await login('https://evil.example');
    assert.equal(untrusted.headers.get('access-control-allow-origin'), null);

    // The bundled app's origin: explicit CORS allowance reflected back.
    const fromApp = await login('https://localhost');
    assert.equal(fromApp.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(fromApp.headers.get('access-control-allow-credentials'), 'true');

    // Now check the cookie attributes themselves on a successful auth call,
    // once from the website and once from the app.
    const signupFromWeb = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signupPayload()),
    });
    const webCookie = signupFromWeb.headers.get('set-cookie');
    assert.match(webCookie, /SameSite=Lax/i);
    assert.doesNotMatch(webCookie, /Secure/i); // plain http:// in tests, so req.secure is false

    const signupFromApp = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://localhost' },
      body: JSON.stringify(signupPayload()),
    });
    const appCookie = signupFromApp.headers.get('set-cookie');
    assert.match(appCookie, /SameSite=None/i);
    assert.match(appCookie, /Secure/i);
  } finally {
    server.close();
  }
});
