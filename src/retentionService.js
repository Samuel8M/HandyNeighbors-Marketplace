'use strict';

// Auto-deletes accounts (and, via ON DELETE CASCADE, every listing,
// review, session, report, and rating tied to them) after 90 days of no
// activity — a standard, privacy-friendly retention window: long enough
// that no one loses an account over a vacation, short enough that stale
// listings and abandoned signups don't linger forever. A 7-day warning
// email goes out first, so deletion never happens without notice.
//
// "Activity" is tracked in users.last_active_at, bumped at signup, at
// login, and (throttled) on any use of an existing session — see
// authService.touchActivity / touchActivityIfStale. Admin accounts are
// exempt (see the is_admin filters below): moderation access shouldn't
// lapse just because no report came in for three months.

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_AFTER_MS = 90 * DAY_MS;
const WARN_AFTER_MS = DELETE_AFTER_MS - 7 * DAY_MS; // 83 days: a week's notice

function cutoffIso(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// Crossed the warn threshold but not the delete one yet, and hasn't
// already been warned this cycle (touchActivity clears
// inactivity_warned_at the moment they come back, so a returning user
// gets a clean slate rather than being permanently flagged).
function findUsersToWarn(db) {
  return db.prepare(`
    SELECT id, email, name FROM users
    WHERE is_admin = 0
      AND last_active_at < ?
      AND last_active_at >= ?
      AND inactivity_warned_at IS NULL
  `).all(cutoffIso(WARN_AFTER_MS), cutoffIso(DELETE_AFTER_MS));
}

function findUsersToDelete(db) {
  return db.prepare(`
    SELECT id, email, name FROM users WHERE is_admin = 0 AND last_active_at < ?
  `).all(cutoffIso(DELETE_AFTER_MS));
}

function markWarned(db, userId) {
  db.prepare("UPDATE users SET inactivity_warned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(userId);
}

function deleteUser(db, userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Runs one full pass: warns everyone newly past 83 days idle, then
// deletes everyone past 90. Idempotent and safe to call as often as you
// like (a warned-and-not-yet-due account is simply skipped next time;
// a deleted account just won't be found again) — see bootstrap() in
// server.js for how often it actually runs in production.
async function sweepInactiveAccounts(db, sendNoticeEmail) {
  const toWarn = findUsersToWarn(db);
  for (const user of toWarn) {
    await sendNoticeEmail(user.email, {
      subject: 'Your HandyNeighbors account is inactive',
      text: `Hi ${user.name},\n\nYour HandyNeighbors account hasn't been used in a while. To keep it — along with any listings or reviews on it — just sign in at https://handyneighbors.onrender.com within the next 7 days.\n\nAfter that, per our data retention policy, inactive accounts and everything tied to them are automatically and permanently deleted. If that's fine with you, no action is needed.`,
    }).catch(() => {}); // best-effort: a failed notice shouldn't stop this from being marked warned
    markWarned(db, user.id);
  }

  const toDelete = findUsersToDelete(db);
  for (const user of toDelete) {
    await sendNoticeEmail(user.email, {
      subject: 'Your HandyNeighbors account has been deleted',
      text: `Hi ${user.name},\n\nYour HandyNeighbors account, and everything tied to it (listings, reviews, ratings), has been automatically and permanently deleted after 90 days of inactivity, per our data retention policy. You're welcome to create a new account any time.`,
    }).catch(() => {});
    deleteUser(db, user.id);
  }

  return { warned: toWarn.length, deleted: toDelete.length };
}

module.exports = {
  sweepInactiveAccounts,
  findUsersToWarn,
  findUsersToDelete,
  WARN_AFTER_MS,
  DELETE_AFTER_MS,
};
