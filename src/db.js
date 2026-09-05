'use strict';

const { DatabaseSync } = require('node:sqlite');

// Curated so the whole platform stays inside the "handyman" lane — tasks
// that don't require a state trade license. Keeping this list fixed (rather
// than free-text) is what makes search, filtering, and price-matching work:
// every worker picks from the same vocabulary.
const SKILLS = [
  'Drywall Repair', 'Painting', 'Faucet Replacement', 'Toilet Repair',
  'Garbage Disposal Repair', 'Outlet & Switch Replacement', 'Door Repair',
  'Window Repair', 'Furniture Assembly', 'Shelving & Mounting',
  'Caulking & Sealing', 'Tile Repair', 'Deck & Fence Repair',
  'Gutter Cleaning', 'Pressure Washing', 'Appliance Installation',
  'Flooring Repair', 'Weatherstripping', 'Minor Carpentry',
  'Lock & Deadbolt Installation',
];

// Grouped by type so the "post a listing" form and worker cards can show
// *what kind* of equipment someone has (access/transport vs. power tools vs.
// diagnostic gear), not just a flat tag cloud.
const EQUIPMENT = [
  { name: 'Ladder', category: 'Access & Transport' },
  { name: 'Truck/Van', category: 'Access & Transport' },
  { name: 'Drill/Driver Set', category: 'Power Tools' },
  { name: 'Circular Saw', category: 'Power Tools' },
  { name: 'Miter Saw', category: 'Power Tools' },
  { name: 'Tile Saw', category: 'Power Tools' },
  { name: 'Nail Gun', category: 'Power Tools' },
  { name: 'Sander', category: 'Power Tools' },
  { name: 'Drain Snake', category: 'Diagnostic & Specialty' },
  { name: 'Multimeter', category: 'Diagnostic & Specialty' },
  { name: 'Stud Finder', category: 'Diagnostic & Specialty' },
  { name: 'Pipe Wrench Set', category: 'Diagnostic & Specialty' },
  { name: 'Pressure Washer', category: 'General & Finishing' },
  { name: 'Wet/Dry Vacuum', category: 'General & Finishing' },
  { name: 'Caulk Gun', category: 'General & Finishing' },
  { name: 'Level Set', category: 'General & Finishing' },
];

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Runs fn inside a transaction, committing on success and rolling back if
 * it throws. node:sqlite's DatabaseSync has no `.transaction()` helper
 * (unlike better-sqlite3), so this is the equivalent: explicit BEGIN,
 * COMMIT on success, ROLLBACK (then rethrow) on failure.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Opens (and initializes if needed) a SQLite database at the given path.
 * Pass ':memory:' for an ephemeral in-memory database (used in tests).
 *
 * Uses Node's built-in node:sqlite (DatabaseSync) rather than
 * better-sqlite3. They were dropped for the same reason: better-sqlite3
 * ships a separately-compiled native binary, and it segfaulted
 * (uncatchably — a native crash, not a JS exception) immediately on start
 * on Render specifically, while an equivalent plain-Node process on the
 * same host ran fine. node:sqlite is compiled and shipped by the Node
 * project itself as part of the Node binary, so there's no separate
 * native artifact that can mismatch the host. Requires Node >=22.13 (no
 * flag needed from that version on; see the `engines` field below).
 *
 * @param {string} filePath
 * @returns {import('node:sqlite').DatabaseSync}
 */
function createDb(filePath) {
  const db = new DatabaseSync(filePath);
  // No WAL pragma here on purpose — see the git history for why (it once
  // relied on mmap-backed shared memory that some hosts' ephemeral/overlay
  // filesystems don't support cleanly). The default rollback journal never
  // touches mmap and is plenty for this app's single-instance, low-write
  // scale.
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT ''
    );

    -- A real account: every listing and review is owned by one of these.
    -- password_hash is 'scrypt:<saltHex>:<derivedKeyHex>' (see
    -- authService.js) — never a plaintext password, never reversible.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      verification_token_hash TEXT,
      verification_sent_at TEXT,
      accepted_terms_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      -- Granted automatically (see authService.syncAdminFlag) to any account
      -- whose email appears in the ADMIN_EMAILS env var — never settable
      -- through the API itself, so there's no "make myself admin" request
      -- to defend against.
      is_admin INTEGER NOT NULL DEFAULT 0,
      -- Set by an admin acting on a report (moderationService.actOnReport).
      -- A banned account keeps browsing/read access and can still delete
      -- itself, but requireNotBanned blocks it from posting listings,
      -- editing them, or leaving reviews.
      banned_at TEXT,
      -- Bumped at signup, at login, and (throttled) on any session use —
      -- see authService's touchActivity — and read by retentionService's
      -- daily sweep to auto-delete accounts idle for 90 days. Never for
      -- an admin account (see retentionService's is_admin exclusion), so
      -- moderation access can't lapse just because no one filed a report
      -- in three months.
      last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      -- Set once retentionService sends the "your account is about to be
      -- deleted for inactivity" warning, so the same account isn't
      -- warned twice before it either logs back in (which clears this,
      -- see authService.touchActivity) or actually gets deleted.
      inactivity_warned_at TEXT
    );

    -- A session is a long random token handed to the browser as a cookie;
    -- only its SHA-256 hash is ever stored, same pattern as the old
    -- edit-token model this replaces (see git history).
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL
    );

    -- One row per individual worker, owned by the account that posted it.
    -- No "company" field on purpose: the platform lists people, not
    -- businesses.
    CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      hourly_rate REAL NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      service_radius_miles INTEGER NOT NULL DEFAULT 10,
      contact_email TEXT,
      contact_phone TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS worker_skills (
      worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (worker_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS worker_equipment (
      worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      PRIMARY KEY (worker_id, equipment_id)
    );

    -- author_name is copied from the reviewer's account name at write time
    -- (denormalized so listing a worker's reviews never needs a join), but
    -- user_id is the real identity behind it: it's what enforces "one
    -- review per person per listing" and "can't review your own listing".
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (worker_id, user_id)
    );

    -- One row per person reporting a listing or review as violating the
    -- platform's rules. Deliberately keeps its own lifecycle (open ->
    -- dismissed/actioned) independent of the content it points at, so a
    -- report survives even if an admin later deletes the reported content.
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('worker', 'review')),
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

    -- The other half of the review system: lets the *worker* rate the
    -- *customer* back, the same way a review lets a customer rate a
    -- worker. See ratingService.js — a rating is only allowed from
    -- someone whose listing the ratee has actually reviewed, which is
    -- this platform's only proxy for "an interaction really happened"
    -- (there's no booking/messaging system to check against instead).
    CREATE TABLE IF NOT EXISTS user_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rater_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ratee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (rater_user_id, ratee_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_ratings_ratee ON user_ratings(ratee_user_id);
    CREATE INDEX IF NOT EXISTS idx_worker_skills_skill ON worker_skills(skill_id);
    CREATE INDEX IF NOT EXISTS idx_worker_equipment_equipment ON worker_equipment(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_workers_city_state ON workers(city, state);
    CREATE INDEX IF NOT EXISTS idx_reviews_worker ON reviews(worker_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
  // idx_workers_user and idx_reviews_worker_user reference columns
  // (user_id) that a pre-accounts database won't have yet — they're
  // created inside the migration below, after it adds that column,
  // rather than here (a fresh database already has the column from the
  // CREATE TABLE above, so creating the index there too is still safe).

  migrateEquipmentCategory(db);
  migrateWorkersAndReviewsToAccounts(db);
  migrateModerationColumns(db);
  migrateRetentionColumns(db);
  seedSkills(db);
  seedEquipment(db);

  return db;
}

// Databases created before equipment categories existed won't have the
// column yet — add it rather than forcing anyone to delete their data file.
function migrateEquipmentCategory(db) {
  const columns = db.prepare('PRAGMA table_info(equipment)').all();
  if (columns.length > 0 && !columns.some((c) => c.name === 'category')) {
    db.exec("ALTER TABLE equipment ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  }
}

// Databases created before accounts existed had anonymous listings/reviews
// (an edit_token_hash instead of a user_id). Rather than lose that data,
// add user_id as nullable — those old rows just become unowned/orphaned
// (no one can edit them via the API, but they still display) — and drop
// the now-unused edit_token_hash column. DROP COLUMN needs SQLite >=3.35,
// which every Node version new enough to have node:sqlite bundles.
function migrateWorkersAndReviewsToAccounts(db) {
  const workerColumns = db.prepare('PRAGMA table_info(workers)').all();
  if (workerColumns.length > 0) {
    if (!workerColumns.some((c) => c.name === 'user_id')) {
      db.exec('ALTER TABLE workers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
    }
    if (workerColumns.some((c) => c.name === 'edit_token_hash')) {
      db.exec('ALTER TABLE workers DROP COLUMN edit_token_hash');
    }
  }

  const reviewColumns = db.prepare('PRAGMA table_info(reviews)').all();
  if (reviewColumns.length > 0 && !reviewColumns.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE reviews ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  }

  // Created here (not in the main schema block above) because these
  // reference user_id, which a pre-accounts database only has as of the
  // ALTER TABLE calls just above — a fresh database already has the
  // column from its CREATE TABLE, so creating the index here too is
  // still correct either way. Old reviews have no user_id, but SQLite
  // treats every NULL as distinct in a unique index, so the constraint is
  // safe to add even with many existing NULL-user_id rows.
  db.exec('CREATE INDEX IF NOT EXISTS idx_workers_user ON workers(user_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_worker_user ON reviews(worker_id, user_id)');
}

// Databases created before moderation existed won't have these columns yet.
function migrateModerationColumns(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.length === 0) return;
  if (!columns.some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some((c) => c.name === 'banned_at')) {
    db.exec('ALTER TABLE users ADD COLUMN banned_at TEXT');
  }
}

// Databases created before the inactivity-retention policy won't have
// these columns. Backfilled to *now* (not, say, created_at) for existing
// rows on purpose — an old account shouldn't be treated as already 90
// days idle the moment this ships; it gets a fresh countdown instead.
function migrateRetentionColumns(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.length === 0) return;
  if (!columns.some((c) => c.name === 'last_active_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_active_at TEXT');
    db.exec("UPDATE users SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE last_active_at IS NULL");
  }
  if (!columns.some((c) => c.name === 'inactivity_warned_at')) {
    db.exec('ALTER TABLE users ADD COLUMN inactivity_warned_at TEXT');
  }
}

function seedSkills(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO skills (slug, name) VALUES (?, ?)');
  withTransaction(db, () => {
    for (const name of SKILLS) insert.run(slugify(name), name);
  });
}

function seedEquipment(db) {
  const insert = db.prepare('INSERT INTO equipment (slug, name, category) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET category = excluded.category');
  withTransaction(db, () => {
    for (const item of EQUIPMENT) insert.run(slugify(item.name), item.name, item.category);
  });
}

module.exports = { createDb, slugify, withTransaction, SKILLS, EQUIPMENT };
