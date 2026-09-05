'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const authSvc = require('../src/authService');
const retentionSvc = require('../src/retentionService');

function freshDb() {
  return createDb(':memory:');
}

async function fakeSignup(db, overrides = {}) {
  const result = await authSvc.signup(db, {
    email: overrides.email || `user-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'correct horse battery staple',
    name: overrides.name || 'Test User',
    acceptedTerms: true,
  }, async () => ({ sent: true, mode: 'fake' }));
  return result.user.id;
}

// Directly backdates last_active_at (and optionally inactivity_warned_at)
// to simulate however many days of silence a real clock would otherwise
// take 90 days to produce.
function backdate(db, userId, daysAgo, { warned = false } = {}) {
  const iso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET last_active_at = ?, inactivity_warned_at = ? WHERE id = ?')
    .run(iso, warned ? iso : null, userId);
}

function fakeNoticeSender() {
  const sent = [];
  const sender = async (email, { subject }) => {
    sent.push({ email, subject });
    return { sent: true, mode: 'fake' };
  };
  sender.sent = sent;
  return sender;
}

test('findUsersToWarn/findUsersToDelete respect the 83/90 day thresholds', async () => {
  const db = freshDb();
  const freshId = await fakeSignup(db, { name: 'Fresh' });
  const day50Id = await fakeSignup(db, { name: 'Day50' });
  const day85Id = await fakeSignup(db, { name: 'Day85' });
  const day95Id = await fakeSignup(db, { name: 'Day95' });
  backdate(db, day50Id, 50);
  backdate(db, day85Id, 85);
  backdate(db, day95Id, 95);

  const toWarn = retentionSvc.findUsersToWarn(db).map((u) => u.id);
  assert.deepEqual(toWarn.sort(), [day85Id].sort());

  const toDelete = retentionSvc.findUsersToDelete(db).map((u) => u.id);
  assert.deepEqual(toDelete, [day95Id]);

  assert.ok(!toWarn.includes(freshId) && !toDelete.includes(freshId));
  assert.ok(!toWarn.includes(day50Id) && !toDelete.includes(day50Id));
});

test('an already-warned account is not warned again, and admins are exempt from both', async () => {
  const db = freshDb();
  const alreadyWarnedId = await fakeSignup(db, { name: 'AlreadyWarned' });
  backdate(db, alreadyWarnedId, 85, { warned: true });

  const adminId = await fakeSignup(db, { name: 'Admin' });
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(adminId);
  backdate(db, adminId, 200); // deeply inactive, but exempt

  assert.equal(retentionSvc.findUsersToWarn(db).length, 0);
  assert.equal(retentionSvc.findUsersToDelete(db).length, 0);
});

test('sweepInactiveAccounts sends notices, warns, deletes, and is idempotent', async () => {
  const db = freshDb();
  const warnCandidateId = await fakeSignup(db, { name: 'WarnMe', email: 'warn@example.com' });
  const deleteCandidateId = await fakeSignup(db, { name: 'DeleteMe', email: 'delete@example.com' });
  backdate(db, warnCandidateId, 85);
  backdate(db, deleteCandidateId, 95);

  const sendNoticeEmail = fakeNoticeSender();
  const result = await retentionSvc.sweepInactiveAccounts(db, sendNoticeEmail);
  assert.deepEqual(result, { warned: 1, deleted: 1 });

  assert.deepEqual(sendNoticeEmail.sent.map((s) => s.email).sort(), ['delete@example.com', 'warn@example.com']);

  const warnedRow = db.prepare('SELECT inactivity_warned_at FROM users WHERE id = ?').get(warnCandidateId);
  assert.ok(warnedRow.inactivity_warned_at);
  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(deleteCandidateId), undefined);

  // Running it again immediately: the warned account isn't warned twice,
  // and there's nothing left to delete.
  const second = await retentionSvc.sweepInactiveAccounts(db, sendNoticeEmail);
  assert.deepEqual(second, { warned: 0, deleted: 0 });
});

test('logging back in clears a pending inactivity warning', async () => {
  const db = freshDb();
  const userId = await fakeSignup(db, { name: 'Returner', email: 'returner@example.com' });
  backdate(db, userId, 85, { warned: true });

  authSvc.login(db, { email: 'returner@example.com', password: 'correct horse battery staple' });

  const row = db.prepare('SELECT last_active_at, inactivity_warned_at FROM users WHERE id = ?').get(userId);
  assert.equal(row.inactivity_warned_at, null);
  assert.ok(new Date(row.last_active_at).getTime() > Date.now() - 5000);
});
