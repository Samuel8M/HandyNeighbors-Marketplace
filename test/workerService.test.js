'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const svc = require('../src/workerService');
const { WorkerServiceError } = svc;

function freshDb() {
  return createDb(':memory:');
}

// workerService only cares that a user_id refers to a real row in
// `users` (the foreign key) — it never touches password/verification
// fields, so a minimal direct insert is enough for these tests, without
// going through authService's async signup + email flow.
function createTestUser(db, overrides = {}) {
  const email = overrides.email || `user-${Math.random().toString(36).slice(2)}@example.com`;
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, name, email_verified, accepted_terms_at)
    VALUES (?, 'scrypt:test:test', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(email, overrides.name || 'Test User', overrides.emailVerified ? 1 : 0);
  return Number(info.lastInsertRowid);
}

function baseWorker(overrides = {}) {
  return {
    name: 'Jordan Reyes',
    bio: 'Ten years fixing everything that squeaks.',
    hourlyRate: 45,
    city: 'Pittsburgh',
    state: 'PA',
    serviceRadiusMiles: 15,
    contactEmail: 'jordan@example.com',
    skills: ['drywall-repair', 'painting'],
    equipment: ['ladder', 'drill-driver-set'],
    ...overrides,
  };
}

test('listEquipment includes each item\'s category', () => {
  const db = freshDb();
  const equipment = svc.listEquipment(db);
  const ladder = equipment.find((e) => e.slug === 'ladder');
  assert.equal(ladder.category, 'Access & Transport');
});

test('createWorker stores a profile owned by the given user', () => {
  const db = freshDb();
  const userId = createTestUser(db, { emailVerified: true });
  const worker = svc.createWorker(db, userId, baseWorker());

  assert.equal(worker.name, 'Jordan Reyes');
  assert.equal(worker.hourlyRate, 45);
  assert.equal(worker.ownerId, userId);
  assert.equal(worker.verified, true);
  assert.ok(worker.memberSince);
  assert.deepEqual(worker.skills.map((s) => s.slug), ['drywall-repair', 'painting']);
  assert.equal(worker.rating, null);
});

test("createWorker reflects the owner's unverified status", () => {
  const db = freshDb();
  const userId = createTestUser(db, { emailVerified: false });
  const worker = svc.createWorker(db, userId, baseWorker());
  assert.equal(worker.verified, false);
});

test('createWorker requires at least one skill', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  assert.throws(
    () => svc.createWorker(db, userId, baseWorker({ skills: [] })),
    (err) => err instanceof WorkerServiceError && err.status === 400
  );
});

test('createWorker requires a contact method', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  assert.throws(
    () => svc.createWorker(db, userId, baseWorker({ contactEmail: undefined, contactPhone: undefined })),
    (err) => err instanceof WorkerServiceError && /contactEmail or contactPhone/.test(err.message)
  );
});

test('createWorker rejects an unknown skill slug', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  assert.throws(
    () => svc.createWorker(db, userId, baseWorker({ skills: ['nuclear-reactor-repair'] })),
    (err) => err instanceof WorkerServiceError && err.status === 400
  );
});

test('createWorker rejects an out-of-range hourly rate', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  assert.throws(
    () => svc.createWorker(db, userId, baseWorker({ hourlyRate: 0 })),
    (err) => err instanceof WorkerServiceError
  );
  assert.throws(
    () => svc.createWorker(db, userId, baseWorker({ hourlyRate: 5000 })),
    (err) => err instanceof WorkerServiceError
  );
});

test('searchWorkers filters by skill, city, and rate range', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  svc.createWorker(db, userId, baseWorker({ name: 'Cheap Chris', hourlyRate: 30 }));
  svc.createWorker(db, userId, baseWorker({ name: 'Pricey Pat', hourlyRate: 90, skills: ['painting'] }));
  svc.createWorker(db, userId, baseWorker({ name: 'Out of Towner', city: 'Cleveland', state: 'OH' }));

  const bySkill = svc.searchWorkers(db, { skill: 'drywall-repair' });
  assert.deepEqual(bySkill.map((w) => w.name).sort(), ['Cheap Chris', 'Out of Towner']);

  const byCity = svc.searchWorkers(db, { city: 'Pittsburgh', state: 'PA' });
  assert.deepEqual(byCity.map((w) => w.name).sort(), ['Cheap Chris', 'Pricey Pat']);

  const byRate = svc.searchWorkers(db, { maxRate: 50 });
  assert.deepEqual(byRate.map((w) => w.name).sort(), ['Cheap Chris', 'Out of Towner']);
});

test('searchWorkers sorts by rate and rating', () => {
  const db = freshDb();
  const owner = createTestUser(db);
  svc.createWorker(db, owner, baseWorker({ name: 'Mid', hourlyRate: 50 }));
  svc.createWorker(db, owner, baseWorker({ name: 'Low', hourlyRate: 20 }));
  svc.createWorker(db, owner, baseWorker({ name: 'High', hourlyRate: 80 }));

  const ascending = svc.searchWorkers(db, { sortBy: 'rate_asc' });
  assert.deepEqual(ascending.map((w) => w.name), ['Low', 'Mid', 'High']);

  const descending = svc.searchWorkers(db, { sortBy: 'rate_desc' });
  assert.deepEqual(descending.map((w) => w.name), ['High', 'Mid', 'Low']);

  const [low] = svc.searchWorkers(db, { sortBy: 'rate_asc' });
  const fan = createTestUser(db);
  svc.addReview(db, fan, low.id, { rating: 5 });
  const byRating = svc.searchWorkers(db, { sortBy: 'rating_desc' });
  assert.equal(byRating[0].name, 'Low');
});

test('listCities aggregates worker count and average rate per city', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  svc.createWorker(db, userId, baseWorker({ name: 'A', hourlyRate: 40, city: 'Pittsburgh', state: 'PA' }));
  svc.createWorker(db, userId, baseWorker({ name: 'B', hourlyRate: 60, city: 'Pittsburgh', state: 'PA' }));
  svc.createWorker(db, userId, baseWorker({ name: 'C', hourlyRate: 30, city: 'Cleveland', state: 'OH' }));

  const cities = svc.listCities(db);
  assert.deepEqual(cities.map((c) => `${c.city}, ${c.state}`), ['Pittsburgh, PA', 'Cleveland, OH']);
  const pittsburgh = cities.find((c) => c.city === 'Pittsburgh');
  assert.equal(pittsburgh.workerCount, 2);
  assert.equal(pittsburgh.averageRate, 50);
});

test("updateWorker rejects a user who doesn't own the listing", () => {
  const db = freshDb();
  const owner = createTestUser(db);
  const someoneElse = createTestUser(db);
  const worker = svc.createWorker(db, owner, baseWorker());

  assert.throws(
    () => svc.updateWorker(db, someoneElse, worker.id, baseWorker({ hourlyRate: 60 })),
    (err) => err instanceof WorkerServiceError && err.status === 403
  );

  const updated = svc.updateWorker(db, owner, worker.id, baseWorker({ hourlyRate: 60 }));
  assert.equal(updated.hourlyRate, 60);
});

test("deleteWorker rejects a user who doesn't own the listing, and removes it for the owner", () => {
  const db = freshDb();
  const owner = createTestUser(db);
  const someoneElse = createTestUser(db);
  const worker = svc.createWorker(db, owner, baseWorker());

  assert.throws(
    () => svc.deleteWorker(db, someoneElse, worker.id),
    (err) => err instanceof WorkerServiceError && err.status === 403
  );

  svc.deleteWorker(db, owner, worker.id);
  assert.throws(
    () => svc.getWorker(db, worker.id),
    (err) => err instanceof WorkerServiceError && err.status === 404
  );
});

test('priceCheck computes average, low, high, and median across matching workers', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  svc.createWorker(db, userId, baseWorker({ name: 'A', hourlyRate: 30 }));
  svc.createWorker(db, userId, baseWorker({ name: 'B', hourlyRate: 50 }));
  svc.createWorker(db, userId, baseWorker({ name: 'C', hourlyRate: 70 }));

  const result = svc.priceCheck(db, { skill: 'drywall-repair' });
  assert.equal(result.count, 3);
  assert.equal(result.low, 30);
  assert.equal(result.high, 70);
  assert.equal(result.average, 50);
  assert.equal(result.median, 50);
});

test('priceCheck narrows by city/state and returns nulls when nobody matches', () => {
  const db = freshDb();
  const userId = createTestUser(db);
  svc.createWorker(db, userId, baseWorker({ name: 'Local', hourlyRate: 40 }));

  const empty = svc.priceCheck(db, { skill: 'drywall-repair', city: 'Nowhere', state: 'ZZ' });
  assert.equal(empty.count, 0);
  assert.equal(empty.average, null);

  const local = svc.priceCheck(db, { skill: 'drywall-repair', city: 'Pittsburgh', state: 'PA' });
  assert.equal(local.count, 1);
});

test('priceCheck rejects an unknown skill', () => {
  const db = freshDb();
  assert.throws(
    () => svc.priceCheck(db, { skill: 'not-a-real-skill' }),
    (err) => err instanceof WorkerServiceError && err.status === 400
  );
});

test('addReview and listReviews track rating, using the reviewer\'s account name', () => {
  const db = freshDb();
  const owner = createTestUser(db);
  const worker = svc.createWorker(db, owner, baseWorker());
  const sam = createTestUser(db, { name: 'Sam' });
  const alex = createTestUser(db, { name: 'Alex' });

  svc.addReview(db, sam, worker.id, { rating: 5, comment: 'Great work!' });
  svc.addReview(db, alex, worker.id, { rating: 3, comment: 'Fine.' });

  const reviews = svc.listReviews(db, worker.id);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((r) => r.authorName).sort(), ['Alex', 'Sam']);

  const refreshed = svc.getWorker(db, worker.id);
  assert.equal(refreshed.rating, 4);
  assert.equal(refreshed.reviewCount, 2);
});

test("addReview rejects reviewing your own listing", () => {
  const db = freshDb();
  const owner = createTestUser(db);
  const worker = svc.createWorker(db, owner, baseWorker());

  assert.throws(
    () => svc.addReview(db, owner, worker.id, { rating: 5 }),
    (err) => err instanceof WorkerServiceError && err.status === 400 && /own listing/.test(err.message)
  );
});

test('addReview rejects a second review from the same user on the same listing', () => {
  const db = freshDb();
  const owner = createTestUser(db);
  const worker = svc.createWorker(db, owner, baseWorker());
  const reviewer = createTestUser(db);

  svc.addReview(db, reviewer, worker.id, { rating: 4 });
  assert.throws(
    () => svc.addReview(db, reviewer, worker.id, { rating: 2 }),
    (err) => err instanceof WorkerServiceError && err.status === 409
  );
});

test('addReview rejects an out-of-range rating', () => {
  const db = freshDb();
  const owner = createTestUser(db);
  const worker = svc.createWorker(db, owner, baseWorker());
  const reviewer = createTestUser(db);
  assert.throws(
    () => svc.addReview(db, reviewer, worker.id, { rating: 9 }),
    (err) => err instanceof WorkerServiceError
  );
});
