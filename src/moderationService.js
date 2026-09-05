'use strict';

// Backs the "report content" flow every signed-in, verified user can reach
// from a listing or a review, and the admin-only screen (see server.js's
// requireAdmin routes) that acts on what comes in. This is the concrete
// answer to Play Console's Content Ratings "User Content Sharing"
// questions: does the app let people report user-generated content, and
// can an admin block/remove it? Both: yes, via this file.

class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TARGET_TYPES = ['worker', 'review'];

// A fixed vocabulary (like SKILLS/EQUIPMENT in db.js) rather than free
// text, so reports stay scannable in bulk instead of becoming another pile
// of one-off strings an admin has to individually read to categorize.
const REASONS = ['spam', 'scam_or_fraud', 'inappropriate_content', 'harassment', 'fake_listing', 'other'];

const ACTIONS = ['dismiss', 'delete_content', 'ban_user', 'delete_and_ban'];

function getTarget(db, targetType, targetId) {
  if (targetType === 'worker') {
    return db.prepare('SELECT id, user_id, name AS label FROM workers WHERE id = ?').get(targetId);
  }
  if (targetType === 'review') {
    return db.prepare('SELECT id, user_id, comment AS label FROM reviews WHERE id = ?').get(targetId);
  }
  return null;
}

function createReport(db, reporterUserId, input) {
  const targetType = String(input.targetType || '').trim();
  if (!TARGET_TYPES.includes(targetType)) {
    throw new ModerationError(400, `targetType must be one of: ${TARGET_TYPES.join(', ')}`);
  }
  const targetId = Number(input.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new ModerationError(400, 'targetId is required');
  }
  const target = getTarget(db, targetType, targetId);
  if (!target) throw new ModerationError(404, 'That listing or review no longer exists');
  if (target.user_id === reporterUserId) {
    throw new ModerationError(400, "You can't report your own content");
  }

  const reason = String(input.reason || '').trim();
  if (!REASONS.includes(reason)) {
    throw new ModerationError(400, `reason must be one of: ${REASONS.join(', ')}`);
  }
  const details = String(input.details || '').trim().slice(0, 500);

  const info = db.prepare(`
    INSERT INTO reports (reporter_user_id, target_type, target_id, reason, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(reporterUserId, targetType, targetId, reason, details);

  return db.prepare(`
    SELECT id, target_type AS targetType, target_id AS targetId, reason, details, status, created_at AS createdAt
    FROM reports WHERE id = ?
  `).get(info.lastInsertRowid);
}

// Admin-facing list. Joins in the reporter's email and a snapshot of the
// target so an admin can triage without a second round trip per report —
// `target` comes back null if the content was already removed by the time
// this is read (e.g. the owner deleted it themselves after being reported).
function listReports(db, { status } = {}) {
  const where = status ? 'WHERE r.status = @status' : '';
  const rows = db.prepare(`
    SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.details,
           r.status, r.created_at AS createdAt, r.resolved_at AS resolvedAt,
           reporter.email AS reporterEmail
    FROM reports r
    JOIN users reporter ON reporter.id = r.reporter_user_id
    ${where}
    ORDER BY r.created_at DESC
  `).all(status ? { status } : {});

  return rows.map((row) => ({ ...row, target: getTarget(db, row.targetType, row.targetId) }));
}

// The one place that actually changes anything as a result of a report:
// - dismiss: no policy violation found, just close it out.
// - delete_content: removes the reported listing/review (cascades to its
//   own reviews if it was a worker), keeps the account intact.
// - ban_user: stops the *account* from posting/reviewing further (see
//   requireNotBanned in server.js) without touching this specific content.
// - delete_and_ban: both at once — the usual response to something that's
//   clearly not a first-time mistake.
function actOnReport(db, reportId, action) {
  if (!ACTIONS.includes(action)) {
    throw new ModerationError(400, `action must be one of: ${ACTIONS.join(', ')}`);
  }
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!report) throw new ModerationError(404, 'Report not found');
  const target = getTarget(db, report.target_type, report.target_id);

  if (action === 'delete_content' || action === 'delete_and_ban') {
    if (target) {
      const table = report.target_type === 'worker' ? 'workers' : 'reviews';
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(report.target_id);
    }
  }
  if (action === 'ban_user' || action === 'delete_and_ban') {
    if (target) {
      db.prepare("UPDATE users SET banned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(target.user_id);
    }
  }

  const status = action === 'dismiss' ? 'dismissed' : 'actioned';
  db.prepare("UPDATE reports SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(status, reportId);

  return db.prepare(`
    SELECT id, target_type AS targetType, target_id AS targetId, reason, details, status, created_at AS createdAt, resolved_at AS resolvedAt
    FROM reports WHERE id = ?
  `).get(reportId);
}

function listBannedUsers(db) {
  return db.prepare(`
    SELECT id, email, name, banned_at AS bannedAt
    FROM users WHERE banned_at IS NOT NULL ORDER BY banned_at DESC
  `).all();
}

function unbanUser(db, userId) {
  const info = db.prepare('UPDATE users SET banned_at = NULL WHERE id = ?').run(userId);
  if (info.changes === 0) throw new ModerationError(404, 'User not found');
}

module.exports = {
  ModerationError,
  REASONS,
  ACTIONS,
  createReport,
  listReports,
  actOnReport,
  listBannedUsers,
  unbanUser,
};
