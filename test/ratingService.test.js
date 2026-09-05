'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const workerSvc = require('../src/workerService');
const ratingSvc = require('../src/ratingService');
const { RatingError } = ratingSvc;

function freshDb() {
  return createDb(':memory:');
}

function createTestUser(db, overrides = {}) {
  const email = overrides.email || `user-${Math.random().toString(36).slice(2)}@example.com`;
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, name, email_verified, accepted_terms_at)
    VALUES (?, 'scrypt:test:test', ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(email, overrides.name || 'Test User');
  return Number(info.lastInsertRowid);
}

function createTestWorker(db, userId, overrides = {}) {
  return workerSvc.createWorker(db, userId, {
    name: 'Jordan Reyes',
    bio: 'Fixes things.',
    hourlyRate: 45,
    city: 'Pittsburgh',
    state: 'PA',
    contactEmail: 'jordan@example.com',
    skills: ['painting'],
    equipment: [],
    ...overrides,
  });
}

test('rateCustomer requires the ratee to have actually reviewed one of the rater\'s listings', () => {
  const db = freshDb();
  const workerOwnerId = createTestUser(db);
  createTestWorker(db, workerOwnerId);
  const strangerId = createTestUser(db);

  assert.throws(
    () => ratingSvc.rateCustomer(db, workerOwnerId, strangerId, { rating: 5 }),
    (err) => err instanceof RatingError && err.status === 403,
  );
});

test('rateCustomer succeeds once a review link exists, rejects a repeat, and rejects self-rating', () => {
  const db = freshDb();
  const workerOwnerId = createTestUser(db, { name: 'Owner Olive' });
  const worker = createTestWorker(db, workerOwnerId);
  const customerId = createTestUser(db, { name: 'Customer Cam' });

  workerSvc.addReview(db, customerId, worker.id, { rating: 5, comment: 'Great work' });

  const created = ratingSvc.rateCustomer(db, workerOwnerId, customerId, { rating: 4, comment: 'Easy to work with' });
  assert.equal(created.rating, 4);

  assert.throws(
    () => ratingSvc.rateCustomer(db, workerOwnerId, customerId, { rating: 3 }),
    (err) => err instanceof RatingError && err.status === 409,
  );
  assert.throws(
    () => ratingSvc.rateCustomer(db, workerOwnerId, workerOwnerId, { rating: 5 }),
    (err) => err instanceof RatingError && err.status === 400,
  );
});

test('rateCustomer rejects an out-of-range rating and an unknown user', () => {
  const db = freshDb();
  const workerOwnerId = createTestUser(db);
  const worker = createTestWorker(db, workerOwnerId);
  const customerId = createTestUser(db);
  workerSvc.addReview(db, customerId, worker.id, { rating: 5 });

  assert.throws(
    () => ratingSvc.rateCustomer(db, workerOwnerId, customerId, { rating: 9 }),
    (err) => err instanceof RatingError && err.status === 400,
  );
  assert.throws(
    () => ratingSvc.rateCustomer(db, workerOwnerId, 999999, { rating: 5 }),
    (err) => err instanceof RatingError && err.status === 404,
  );
});

test('getUserRatingSummary averages across raters and is null/0 with no ratings yet', () => {
  const db = freshDb();
  const workerOwnerId = createTestUser(db);
  const worker = createTestWorker(db, workerOwnerId);
  const customerId = createTestUser(db);
  workerSvc.addReview(db, customerId, worker.id, { rating: 5 });

  assert.deepEqual(ratingSvc.getUserRatingSummary(db, customerId), { average: null, count: 0 });

  ratingSvc.rateCustomer(db, workerOwnerId, customerId, { rating: 5 });
  const secondWorkerOwnerId = createTestUser(db);
  const secondWorker = createTestWorker(db, secondWorkerOwnerId, { name: 'Second Worker' });
  workerSvc.addReview(db, customerId, secondWorker.id, { rating: 5 });
  ratingSvc.rateCustomer(db, secondWorkerOwnerId, customerId, { rating: 3 });

  assert.deepEqual(ratingSvc.getUserRatingSummary(db, customerId), { average: 4, count: 2 });
});
