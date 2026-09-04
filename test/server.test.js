'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createDb } = require('../src/db');
const { createApp } = require('../src/server');

function startServer() {
  const db = createDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function request(baseUrl, method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

function samplePayload(overrides = {}) {
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

test('GET /api/skills and /api/equipment return seeded lists', async () => {
  const { server, baseUrl } = startServer();
  try {
    const skills = await request(baseUrl, 'GET', '/api/skills');
    assert.equal(skills.status, 200);
    assert.ok(skills.body.length > 0);
    assert.ok(skills.body.some((s) => s.slug === 'drywall-repair'));

    const equipment = await request(baseUrl, 'GET', '/api/equipment');
    assert.equal(equipment.status, 200);
    assert.ok(equipment.body.some((e) => e.slug === 'ladder'));
  } finally {
    server.close();
  }
});

test('GET /api/cities aggregates listings once workers exist', async () => {
  const { server, baseUrl } = startServer();
  try {
    await request(baseUrl, 'POST', '/api/workers', samplePayload({ city: 'Pittsburgh', state: 'PA' }));
    await request(baseUrl, 'POST', '/api/workers', samplePayload({ name: 'Second Worker', city: 'Pittsburgh', state: 'PA' }));

    const { status, body } = await request(baseUrl, 'GET', '/api/cities');
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal(body[0].city, 'Pittsburgh');
    assert.equal(body[0].workerCount, 2);
  } finally {
    server.close();
  }
});

test('full worker lifecycle: create, search, price-check, review, update, delete', async () => {
  const { server, baseUrl } = startServer();
  try {
    const created = await request(baseUrl, 'POST', '/api/workers', samplePayload());
    assert.equal(created.status, 201);
    const { worker, editToken } = created.body;
    assert.ok(worker.id);
    assert.ok(editToken);

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

    const review = await request(baseUrl, 'POST', `/api/workers/${worker.id}/reviews`, {
      authorName: 'Sam', rating: 5, comment: 'Fixed my sink fast.',
    });
    assert.equal(review.status, 201);

    const reviews = await request(baseUrl, 'GET', `/api/workers/${worker.id}/reviews`);
    assert.equal(reviews.body.length, 1);

    const badUpdate = await request(baseUrl, 'PUT', `/api/workers/${worker.id}`, samplePayload({ hourlyRate: 60 }), {
      'X-Edit-Token': 'wrong',
    });
    assert.equal(badUpdate.status, 403);

    const update = await request(baseUrl, 'PUT', `/api/workers/${worker.id}`, samplePayload({ hourlyRate: 60 }), {
      'X-Edit-Token': editToken,
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.hourlyRate, 60);

    const del = await request(baseUrl, 'DELETE', `/api/workers/${worker.id}`, null, { 'X-Edit-Token': editToken });
    assert.equal(del.status, 204);

    const gone = await request(baseUrl, 'GET', `/api/workers/${worker.id}`);
    assert.equal(gone.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/workers returns 400 for invalid input', async () => {
  const { server, baseUrl } = startServer();
  try {
    const { status, body } = await request(baseUrl, 'POST', '/api/workers', samplePayload({ skills: [] }));
    assert.equal(status, 400);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});
