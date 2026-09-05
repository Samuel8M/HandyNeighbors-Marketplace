'use strict';

// The other direction of the review system: workerService.addReview lets a
// customer rate a worker's listing; this lets that worker rate the
// customer back, the way Airbnb has both a host and a guest leave a
// review after a stay. HandyNeighbors has no booking/messaging system to
// confirm a job actually happened, so — same as reviews already do in the
// other direction — "left a review on one of my listings" is the
// platform's only proxy for "we really interacted."

class RatingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;

function hasReviewedRatersListing(db, raterUserId, rateeUserId) {
  const row = db.prepare(`
    SELECT 1 FROM reviews r
    JOIN workers w ON w.id = r.worker_id
    WHERE w.user_id = ? AND r.user_id = ?
    LIMIT 1
  `).get(raterUserId, rateeUserId);
  return !!row;
}

// Only the worker whose listing was reviewed can rate that reviewer back,
// and only once per pair (UNIQUE(rater_user_id, ratee_user_id) — repeat
// calls are caught below and turned into a 409, the same pattern
// workerService.addReview uses for a repeat worker review).
function rateCustomer(db, raterUserId, rateeUserId, input) {
  if (raterUserId === rateeUserId) {
    throw new RatingError(400, "You can't rate yourself");
  }
  const ratee = db.prepare('SELECT id FROM users WHERE id = ?').get(rateeUserId);
  if (!ratee) throw new RatingError(404, 'User not found');
  if (!hasReviewedRatersListing(db, raterUserId, rateeUserId)) {
    throw new RatingError(403, 'You can only rate someone who has reviewed one of your listings');
  }

  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new RatingError(400, 'rating must be an integer between 1 and 5');
  }
  const comment = String(input.comment || '').trim().slice(0, 1000);

  let info;
  try {
    info = db.prepare(`
      INSERT INTO user_ratings (rater_user_id, ratee_user_id, rating, comment) VALUES (?, ?, ?, ?)
    `).run(raterUserId, rateeUserId, rating, comment);
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
      throw new RatingError(409, "You've already rated this person");
    }
    throw err;
  }

  return db.prepare('SELECT id, rater_user_id AS raterUserId, ratee_user_id AS rateeUserId, rating, comment, created_at AS createdAt FROM user_ratings WHERE id = ?')
    .get(info.lastInsertRowid);
}

// Public — shown next to anyone's name wherever they appear as a
// reviewer, and on their own account, so a customer builds the same kind
// of visible track record a worker's listing does.
function getUserRatingSummary(db, userId) {
  const row = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS count FROM user_ratings WHERE ratee_user_id = ?').get(userId);
  return {
    average: row.count > 0 ? Math.round(row.avg * 10) / 10 : null,
    count: row.count,
  };
}

module.exports = { RatingError, rateCustomer, getUserRatingSummary };
