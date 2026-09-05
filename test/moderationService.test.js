'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const workerSvc = require('../src/workerService');
const modSvc = require('../src/moderationService');
const { ModerationError } = modSvc;

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

test('createReport records who reported what, and rejects self-reports', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);

  const report = modSvc.createReport(db, reporterId, {
    targetType: 'worker', targetId: worker.id, reason: 'spam', details: 'Looks fake',
  });
  assert.equal(report.status, 'open');
  assert.equal(report.targetId, worker.id);

  assert.throws(
    () => modSvc.createReport(db, ownerId, { targetType: 'worker', targetId: worker.id, reason: 'spam' }),
    (err) => err instanceof ModerationError && err.status === 400,
  );
});

test('createReport rejects an unknown reason or a nonexistent target', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);

  assert.throws(
    () => modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker.id, reason: 'not_a_real_reason' }),
    (err) => err instanceof ModerationError && err.status === 400,
  );
  assert.throws(
    () => modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: 999999, reason: 'spam' }),
    (err) => err instanceof ModerationError && err.status === 404,
  );
});

test('listReports filters by status and includes a target snapshot', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);
  modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker.id, reason: 'spam' });

  const open = modSvc.listReports(db, { status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].target.label, 'Jordan Reyes');
  assert.equal(open[0].reporterEmail !== undefined, true);

  assert.equal(modSvc.listReports(db, { status: 'dismissed' }).length, 0);
});

test('actOnReport: dismiss closes the report without touching content', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);
  const report = modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker.id, reason: 'other' });

  const result = modSvc.actOnReport(db, report.id, 'dismiss');
  assert.equal(result.status, 'dismissed');
  assert.ok(workerSvc.getWorker(db, worker.id)); // still exists
});

test('actOnReport: delete_content removes the listing, ban_user suspends its owner', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);

  const r1 = modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker.id, reason: 'fake_listing' });
  modSvc.actOnReport(db, r1.id, 'delete_content');
  assert.throws(() => workerSvc.getWorker(db, worker.id), (err) => err instanceof workerSvc.WorkerServiceError && err.status === 404);

  const worker2 = createTestWorker(db, ownerId, { name: 'Second Listing' });
  const r2 = modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker2.id, reason: 'harassment' });
  modSvc.actOnReport(db, r2.id, 'ban_user');
  const banned = modSvc.listBannedUsers(db);
  assert.equal(banned.length, 1);
  assert.equal(banned[0].id, ownerId);
  // Content untouched by a plain ban_user (only delete_and_ban removes it).
  assert.ok(workerSvc.getWorker(db, worker2.id));
});

test('unbanUser clears a suspension', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);
  const report = modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker.id, reason: 'other' });
  modSvc.actOnReport(db, report.id, 'ban_user');
  assert.equal(modSvc.listBannedUsers(db).length, 1);

  modSvc.unbanUser(db, ownerId);
  assert.equal(modSvc.listBannedUsers(db).length, 0);
});

test('actOnReport rejects an unknown action', () => {
  const db = freshDb();
  const ownerId = createTestUser(db);
  const worker = createTestWorker(db, ownerId);
  const reporterId = createTestUser(db);
  const report = modSvc.createReport(db, reporterId, { targetType: 'worker', targetId: worker.id, reason: 'other' });

  assert.throws(
    () => modSvc.actOnReport(db, report.id, 'nonsense'),
    (err) => err instanceof ModerationError && err.status === 400,
  );
});
