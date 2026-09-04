'use strict';

const Database = require('better-sqlite3');

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
 * Opens (and initializes if needed) a SQLite database at the given path.
 * Pass ':memory:' for an ephemeral in-memory database (used in tests).
 *
 * @param {string} filePath
 * @returns {import('better-sqlite3').Database}
 */
function createDb(filePath) {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

    -- One row per individual worker. No "company" field on purpose: the
    -- platform lists people, not businesses.
    CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      hourly_rate REAL NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      service_radius_miles INTEGER NOT NULL DEFAULT 10,
      contact_email TEXT,
      contact_phone TEXT,
      edit_token_hash TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_worker_skills_skill ON worker_skills(skill_id);
    CREATE INDEX IF NOT EXISTS idx_worker_equipment_equipment ON worker_equipment(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_workers_city_state ON workers(city, state);
    CREATE INDEX IF NOT EXISTS idx_reviews_worker ON reviews(worker_id);
  `);

  migrateEquipmentCategory(db);
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

function seedSkills(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO skills (slug, name) VALUES (?, ?)');
  const insertAll = db.transaction((items) => {
    for (const name of items) insert.run(slugify(name), name);
  });
  insertAll(SKILLS);
}

function seedEquipment(db) {
  const insert = db.prepare('INSERT INTO equipment (slug, name, category) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET category = excluded.category');
  const insertAll = db.transaction((items) => {
    for (const item of items) insert.run(slugify(item.name), item.name, item.category);
  });
  insertAll(EQUIPMENT);
}

module.exports = { createDb, slugify, SKILLS, EQUIPMENT };
