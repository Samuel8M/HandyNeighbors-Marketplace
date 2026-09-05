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

function startServer() {
  const db = createDb(':memory:');
  const sendVerificationEmail = fakeEmailSender();
  const app = createApp(db, { sendVerificationEmail });
  const server = app.listen(0);
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}`, sendVerificationEmail };
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
