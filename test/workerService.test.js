'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const svc = require('../src/workerService');
const { WorkerServiceError } = svc;

function freshDb() {
  return createDb(':memory:');
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

test('createWorker stores a profile and returns a one-time edit token', () => {
  const db = freshDb();
  const { worker, editToken } = svc.createWorker(db, baseWorker());

  assert.equal(worker.name, 'Jordan Reyes');
  assert.equal(worker.hourlyRate, 45);
  assert.deepEqual(worker.skills.map((s) => s.slug), ['drywall-repair', 'painting']);
  assert.equal(worker.rating, null);
  assert.match(editToken, /^[a-f0-9]{48}$/);
});

test('createWorker requires at least one skill', () => {
  const db = freshDb();
  assert.throws(
    () => svc.createWorker(db, baseWorker({ skills: [] })),
    (err) => err instanceof WorkerServiceError && err.status === 400
  );
});

test('createWorker requires a contact method', () => {
  const db = freshDb();
  assert.throws(
    () => svc.createWorker(db, baseWorker({ contactEmail: undefined, contactPhone: undefined })),
    (err) => err instanceof WorkerServiceError && /contactEmail or contactPhone/.test(err.message)
  );
});

test('createWorker rejects an unknown skill slug', () => {
  const db = freshDb();
  assert.throws(
    () => svc.createWorker(db, baseWorker({ skills: ['nuclear-reactor-repair'] })),
    (err) => err instanceof WorkerServiceError && err.status === 400
  );
});

test('createWorker rejects an out-of-range hourly rate', () => {
  const db = freshDb();
  assert.throws(
    () => svc.createWorker(db, baseWorker({ hourlyRate: 0 })),
    (err) => err instanceof WorkerServiceError
  );
  assert.throws(
    () => svc.createWorker(db, baseWorker({ hourlyRate: 5000 })),
    (err) => err instanceof WorkerServiceError
  );
});

test('searchWorkers filters by skill, city, and rate range', () => {
  const db = freshDb();
  svc.createWorker(db, baseWorker({ name: 'Cheap Chris', hourlyRate: 30 }));
  svc.createWorker(db, baseWorker({ name: 'Pricey Pat', hourlyRate: 90, skills: ['painting'] }));
  svc.createWorker(db, baseWorker({ name: 'Out of Towner', city: 'Cleveland', state: 'OH' }));

  const bySkill = svc.searchWorkers(db, { skill: 'drywall-repair' });
  assert.deepEqual(bySkill.map((w) => w.name).sort(), ['Cheap Chris', 'Out of Towner']);

  const byCity = svc.searchWorkers(db, { city: 'Pittsburgh', state: 'PA' });
  assert.deepEqual(byCity.map((w) => w.name).sort(), ['Cheap Chris', 'Pricey Pat']);

  const byRate = svc.searchWorkers(db, { maxRate: 50 });
  assert.deepEqual(byRate.map((w) => w.name).sort(), ['Cheap Chris', 'Out of Towner']);
});

test('searchWorkers sorts by rate and rating', () => {
  const db = freshDb();
  svc.createWorker(db, baseWorker({ name: 'Mid', hourlyRate: 50 }));
  svc.createWorker(db, baseWorker({ name: 'Low', hourlyRate: 20 }));
  svc.createWorker(db, baseWorker({ name: 'High', hourlyRate: 80 }));

  const ascending = svc.searchWorkers(db, { sortBy: 'rate_asc' });
  assert.deepEqual(ascending.map((w) => w.name), ['Low', 'Mid', 'High']);

  const descending = svc.searchWorkers(db, { sortBy: 'rate_desc' });
  assert.deepEqual(descending.map((w) => w.name), ['High', 'Mid', 'Low']);

  const [low] = svc.searchWorkers(db, { sortBy: 'rate_asc' });
  svc.addReview(db, low.id, { authorName: 'Fan', rating: 5 });
  const byRating = svc.searchWorkers(db, { sortBy: 'rating_desc' });
  assert.equal(byRating[0].name, 'Low');
});

test('listCities aggregates worker count and average rate per city', () => {
  const db = freshDb();
  svc.createWorker(db, baseWorker({ name: 'A', hourlyRate: 40, city: 'Pittsburgh', state: 'PA' }));
  svc.createWorker(db, baseWorker({ name: 'B', hourlyRate: 60, city: 'Pittsburgh', state: 'PA' }));
  svc.createWorker(db, baseWorker({ name: 'C', hourlyRate: 30, city: 'Cleveland', state: 'OH' }));

  const cities = svc.listCities(db);
  assert.deepEqual(cities.map((c) => `${c.city}, ${c.state}`), ['Pittsburgh, PA', 'Cleveland, OH']);
  const pittsburgh = cities.find((c) => c.city === 'Pittsburgh');
  assert.equal(pittsburgh.workerCount, 2);
  assert.equal(pittsburgh.averageRate, 50);
});

test('updateWorker requires a valid edit token', () => {
  const db = freshDb();
  const { worker, editToken } = svc.createWorker(db, baseWorker());

  assert.throws(
    () => svc.updateWorker(db, worker.id, 'wrong-token', baseWorker({ hourlyRate: 60 })),
    (err) => err instanceof WorkerServiceError && err.status === 403
  );

  const updated = svc.updateWorker(db, worker.id, editToken, baseWorker({ hourlyRate: 60 }));
  assert.equal(updated.hourlyRate, 60);
});

test('deleteWorker requires a valid edit token and removes the listing', () => {
  const db = freshDb();
  const { worker, editToken } = svc.createWorker(db, baseWorker());

  assert.throws(
    () => svc.deleteWorker(db, worker.id, 'wrong-token'),
    (err) => err instanceof WorkerServiceError && err.status === 403
  );

  svc.deleteWorker(db, worker.id, editToken);
  assert.throws(
    () => svc.getWorker(db, worker.id),
    (err) => err instanceof WorkerServiceError && err.status === 404
  );
});

test('priceCheck computes average, low, high, and median across matching workers', () => {
  const db = freshDb();
  svc.createWorker(db, baseWorker({ name: 'A', hourlyRate: 30 }));
  svc.createWorker(db, baseWorker({ name: 'B', hourlyRate: 50 }));
  svc.createWorker(db, baseWorker({ name: 'C', hourlyRate: 70 }));

  const result = svc.priceCheck(db, { skill: 'drywall-repair' });
  assert.equal(result.count, 3);
  assert.equal(result.low, 30);
  assert.equal(result.high, 70);
  assert.equal(result.average, 50);
  assert.equal(result.median, 50);
});

test('priceCheck narrows by city/state and returns nulls when nobody matches', () => {
  const db = freshDb();
  svc.createWorker(db, baseWorker({ name: 'Local', hourlyRate: 40 }));

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

test('addReview and listReviews track rating and update the worker average', () => {
  const db = freshDb();
  const { worker } = svc.createWorker(db, baseWorker());

  svc.addReview(db, worker.id, { authorName: 'Sam', rating: 5, comment: 'Great work!' });
  svc.addReview(db, worker.id, { authorName: 'Alex', rating: 3, comment: 'Fine.' });

  const reviews = svc.listReviews(db, worker.id);
  assert.equal(reviews.length, 2);

  const refreshed = svc.getWorker(db, worker.id);
  assert.equal(refreshed.rating, 4);
  assert.equal(refreshed.reviewCount, 2);
});

test('addReview rejects an out-of-range rating', () => {
  const db = freshDb();
  const { worker } = svc.createWorker(db, baseWorker());
  assert.throws(
    () => svc.addReview(db, worker.id, { authorName: 'Sam', rating: 9 }),
    (err) => err instanceof WorkerServiceError
  );
});
