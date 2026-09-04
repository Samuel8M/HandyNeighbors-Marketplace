'use strict';

const crypto = require('crypto');
const { slugify, withTransaction } = require('./db');

class WorkerServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_RATE = 500;
const MIN_RATE = 1;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateEditToken() {
  return crypto.randomBytes(24).toString('hex');
}

function tokensMatch(providedHash, storedHash) {
  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cleanString(value, { field, max, required = true }) {
  if (value === undefined || value === null) {
    if (required) throw new WorkerServiceError(400, `${field} is required`);
    return '';
  }
  const trimmed = String(value).trim();
  if (required && trimmed.length === 0) {
    throw new WorkerServiceError(400, `${field} is required`);
  }
  if (max && trimmed.length > max) {
    throw new WorkerServiceError(400, `${field} must be ${max} characters or fewer`);
  }
  return trimmed;
}

function resolveLookupIds(db, table, slugs, { field }) {
  if (!Array.isArray(slugs)) {
    throw new WorkerServiceError(400, `${field} must be a list`);
  }
  const unique = [...new Set(slugs.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return [];
  if (unique.length > 20) {
    throw new WorkerServiceError(400, `${field} cannot list more than 20 items`);
  }
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, slug FROM ${table} WHERE slug IN (${placeholders})`).all(...unique);
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((r) => r.slug));
    const missing = unique.filter((s) => !found.has(s));
    throw new WorkerServiceError(400, `Unknown ${field}: ${missing.join(', ')}`);
  }
  return rows.map((r) => r.id);
}

function listSkills(db) {
  return db.prepare('SELECT slug, name FROM skills ORDER BY name').all();
}

function listEquipment(db) {
  return db.prepare('SELECT slug, name, category FROM equipment ORDER BY category, name').all();
}

// Powers "browse by city": every distinct city/state that has at least one
// active listing, with a headcount and average rate, most-listings-first.
function listCities(db) {
  return db.prepare(`
    SELECT city, state, COUNT(*) AS workerCount, ROUND(AVG(hourly_rate), 2) AS averageRate
    FROM workers
    GROUP BY LOWER(city), LOWER(state)
    ORDER BY workerCount DESC, city ASC
  `).all();
}

function validateWorkerInput(db, input) {
  const name = cleanString(input.name, { field: 'name', max: 80 });
  const bio = cleanString(input.bio, { field: 'bio', max: 1000, required: false });
  const city = cleanString(input.city, { field: 'city', max: 80 });
  const state = cleanString(input.state, { field: 'state', max: 40 });
  const contactEmail = cleanString(input.contactEmail, { field: 'contactEmail', max: 200, required: false });
  const contactPhone = cleanString(input.contactPhone, { field: 'contactPhone', max: 40, required: false });

  if (!contactEmail && !contactPhone) {
    throw new WorkerServiceError(400, 'Provide at least one way to reach you: contactEmail or contactPhone');
  }

  const hourlyRate = Number(input.hourlyRate);
  if (!Number.isFinite(hourlyRate) || hourlyRate < MIN_RATE || hourlyRate > MAX_RATE) {
    throw new WorkerServiceError(400, `hourlyRate must be a number between ${MIN_RATE} and ${MAX_RATE}`);
  }

  let serviceRadiusMiles = 10;
  if (input.serviceRadiusMiles !== undefined && input.serviceRadiusMiles !== null && input.serviceRadiusMiles !== '') {
    serviceRadiusMiles = Number(input.serviceRadiusMiles);
    if (!Number.isInteger(serviceRadiusMiles) || serviceRadiusMiles < 1 || serviceRadiusMiles > 200) {
      throw new WorkerServiceError(400, 'serviceRadiusMiles must be an integer between 1 and 200');
    }
  }

  const skillIds = resolveLookupIds(db, 'skills', input.skills || [], { field: 'skills' });
  if (skillIds.length === 0) {
    throw new WorkerServiceError(400, 'At least one skill is required');
  }
  const equipmentIds = resolveLookupIds(db, 'equipment', input.equipment || [], { field: 'equipment' });

  return { name, bio, city, state, contactEmail, contactPhone, hourlyRate, serviceRadiusMiles, skillIds, equipmentIds };
}

function createWorker(db, input) {
  const data = validateWorkerInput(db, input);
  const editToken = generateEditToken();
  const editTokenHash = hashToken(editToken);

  const insertWorker = db.prepare(`
    INSERT INTO workers (name, bio, hourly_rate, city, state, service_radius_miles, contact_email, contact_phone, edit_token_hash)
    VALUES (@name, @bio, @hourlyRate, @city, @state, @serviceRadiusMiles, @contactEmail, @contactPhone, @editTokenHash)
  `);
  const insertSkill = db.prepare('INSERT INTO worker_skills (worker_id, skill_id) VALUES (?, ?)');
  const insertEquipment = db.prepare('INSERT INTO worker_equipment (worker_id, equipment_id) VALUES (?, ?)');

  const workerId = withTransaction(db, () => {
    const info = insertWorker.run({
      name: data.name,
      bio: data.bio,
      hourlyRate: data.hourlyRate,
      city: data.city,
      state: data.state,
      serviceRadiusMiles: data.serviceRadiusMiles,
      contactEmail: data.contactEmail || null,
      contactPhone: data.contactPhone || null,
      editTokenHash,
    });
    for (const skillId of data.skillIds) insertSkill.run(info.lastInsertRowid, skillId);
    for (const equipmentId of data.equipmentIds) insertEquipment.run(info.lastInsertRowid, equipmentId);
    return info.lastInsertRowid;
  });

  return { worker: getWorker(db, workerId), editToken };
}

function attachTagsAndRating(db, worker) {
  const skills = db.prepare(`
    SELECT s.slug, s.name FROM worker_skills ws
    JOIN skills s ON s.id = ws.skill_id WHERE ws.worker_id = ? ORDER BY s.name
  `).all(worker.id);
  const equipment = db.prepare(`
    SELECT e.slug, e.name, e.category FROM worker_equipment we
    JOIN equipment e ON e.id = we.equipment_id WHERE we.worker_id = ? ORDER BY e.category, e.name
  `).all(worker.id);
  const ratingRow = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS count FROM reviews WHERE worker_id = ?').get(worker.id);

  return {
    id: worker.id,
    name: worker.name,
    bio: worker.bio,
    hourlyRate: worker.hourly_rate,
    city: worker.city,
    state: worker.state,
    serviceRadiusMiles: worker.service_radius_miles,
    contactEmail: worker.contact_email,
    contactPhone: worker.contact_phone,
    createdAt: worker.created_at,
    updatedAt: worker.updated_at,
    skills,
    equipment,
    rating: ratingRow.count > 0 ? Math.round(ratingRow.avg * 10) / 10 : null,
    reviewCount: ratingRow.count,
  };
}

function getWorker(db, id) {
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  if (!worker) throw new WorkerServiceError(404, 'Worker not found');
  return attachTagsAndRating(db, worker);
}

function searchWorkers(db, filters = {}) {
  const clauses = [];
  const params = {};

  if (filters.city) {
    clauses.push('LOWER(w.city) = LOWER(@city)');
    params.city = filters.city;
  }
  if (filters.state) {
    clauses.push('LOWER(w.state) = LOWER(@state)');
    params.state = filters.state;
  }
  if (filters.minRate !== undefined && filters.minRate !== '') {
    clauses.push('w.hourly_rate >= @minRate');
    params.minRate = Number(filters.minRate);
  }
  if (filters.maxRate !== undefined && filters.maxRate !== '') {
    clauses.push('w.hourly_rate <= @maxRate');
    params.maxRate = Number(filters.maxRate);
  }
  if (filters.q) {
    clauses.push('(LOWER(w.name) LIKE @q OR LOWER(w.bio) LIKE @q)');
    params.q = `%${String(filters.q).trim().toLowerCase()}%`;
  }
  if (filters.skill) {
    clauses.push(`w.id IN (
      SELECT ws.worker_id FROM worker_skills ws JOIN skills s ON s.id = ws.skill_id WHERE s.slug = @skill
    )`);
    params.skill = slugify(filters.skill);
  }
  if (filters.equipment) {
    clauses.push(`w.id IN (
      SELECT we.worker_id FROM worker_equipment we JOIN equipment e ON e.id = we.equipment_id WHERE e.slug = @equipment
    )`);
    params.equipment = slugify(filters.equipment);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT w.* FROM workers w ${where} ORDER BY w.created_at DESC`).all(params);
  const workers = rows.map((row) => attachTagsAndRating(db, row));

  return sortWorkers(workers, filters.sortBy);
}

const SORTERS = {
  newest: null, // already the SQL order
  rate_asc: (a, b) => a.hourlyRate - b.hourlyRate,
  rate_desc: (a, b) => b.hourlyRate - a.hourlyRate,
  rating_desc: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
};

function sortWorkers(workers, sortBy) {
  const sorter = SORTERS[sortBy];
  return sorter ? [...workers].sort(sorter) : workers;
}

function verifyEditToken(db, workerId, providedToken) {
  const row = db.prepare('SELECT edit_token_hash FROM workers WHERE id = ?').get(workerId);
  if (!row) throw new WorkerServiceError(404, 'Worker not found');
  if (!providedToken || !tokensMatch(hashToken(String(providedToken)), row.edit_token_hash)) {
    throw new WorkerServiceError(403, 'Invalid or missing edit token');
  }
}

function updateWorker(db, workerId, editToken, input) {
  verifyEditToken(db, workerId, editToken);
  const data = validateWorkerInput(db, input);

  withTransaction(db, () => {
    // node:sqlite (unlike better-sqlite3) throws on a named-params object
    // that carries keys the SQL doesn't reference, so this lists exactly
    // the columns the UPDATE uses rather than spreading all of `data`
    // (which also carries skillIds/equipmentIds).
    db.prepare(`
      UPDATE workers SET name=@name, bio=@bio, hourly_rate=@hourlyRate, city=@city, state=@state,
        service_radius_miles=@serviceRadiusMiles, contact_email=@contactEmail, contact_phone=@contactPhone,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=@id
    `).run({
      name: data.name,
      bio: data.bio,
      hourlyRate: data.hourlyRate,
      city: data.city,
      state: data.state,
      serviceRadiusMiles: data.serviceRadiusMiles,
      contactEmail: data.contactEmail || null,
      contactPhone: data.contactPhone || null,
      id: workerId,
    });

    db.prepare('DELETE FROM worker_skills WHERE worker_id = ?').run(workerId);
    db.prepare('DELETE FROM worker_equipment WHERE worker_id = ?').run(workerId);
    const insertSkill = db.prepare('INSERT INTO worker_skills (worker_id, skill_id) VALUES (?, ?)');
    const insertEquipment = db.prepare('INSERT INTO worker_equipment (worker_id, equipment_id) VALUES (?, ?)');
    for (const skillId of data.skillIds) insertSkill.run(workerId, skillId);
    for (const equipmentId of data.equipmentIds) insertEquipment.run(workerId, equipmentId);
  });

  return getWorker(db, workerId);
}

function deleteWorker(db, workerId, editToken) {
  verifyEditToken(db, workerId, editToken);
  db.prepare('DELETE FROM workers WHERE id = ?').run(workerId);
}

// The price-matching engine: for a given skill (optionally narrowed to a
// city/state), reports what other workers charge so both sides can see
// whether a rate is in line with the local market.
function priceCheck(db, { skill, city, state }) {
  if (!skill) throw new WorkerServiceError(400, 'skill is required');
  const skillSlug = slugify(skill);
  const skillRow = db.prepare('SELECT id, name FROM skills WHERE slug = ?').get(skillSlug);
  if (!skillRow) throw new WorkerServiceError(400, `Unknown skill: ${skill}`);

  const clauses = ['ws.skill_id = @skillId'];
  const params = { skillId: skillRow.id };
  if (city) {
    clauses.push('LOWER(w.city) = LOWER(@city)');
    params.city = city;
  }
  if (state) {
    clauses.push('LOWER(w.state) = LOWER(@state)');
    params.state = state;
  }

  const rows = db.prepare(`
    SELECT w.id, w.name, w.hourly_rate AS hourlyRate, w.city, w.state
    FROM workers w JOIN worker_skills ws ON ws.worker_id = w.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY w.hourly_rate ASC
  `).all(params);

  if (rows.length === 0) {
    return { skill: skillRow.name, count: 0, average: null, low: null, high: null, median: null, workers: [] };
  }

  const rates = rows.map((r) => r.hourlyRate);
  const sum = rates.reduce((a, b) => a + b, 0);
  const mid = Math.floor(rates.length / 2);
  const median = rates.length % 2 === 0 ? (rates[mid - 1] + rates[mid]) / 2 : rates[mid];

  return {
    skill: skillRow.name,
    count: rows.length,
    average: Math.round((sum / rows.length) * 100) / 100,
    low: rates[0],
    high: rates[rates.length - 1],
    median,
    workers: rows,
  };
}

function addReview(db, workerId, input) {
  const worker = db.prepare('SELECT id FROM workers WHERE id = ?').get(workerId);
  if (!worker) throw new WorkerServiceError(404, 'Worker not found');

  const authorName = cleanString(input.authorName, { field: 'authorName', max: 80 });
  const comment = cleanString(input.comment, { field: 'comment', max: 1000, required: false });
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new WorkerServiceError(400, 'rating must be an integer between 1 and 5');
  }

  const info = db.prepare(`
    INSERT INTO reviews (worker_id, author_name, rating, comment) VALUES (?, ?, ?, ?)
  `).run(workerId, authorName, rating, comment);

  return db.prepare('SELECT id, author_name AS authorName, rating, comment, created_at AS createdAt FROM reviews WHERE id = ?')
    .get(info.lastInsertRowid);
}

function listReviews(db, workerId) {
  const worker = db.prepare('SELECT id FROM workers WHERE id = ?').get(workerId);
  if (!worker) throw new WorkerServiceError(404, 'Worker not found');
  return db.prepare(`
    SELECT id, author_name AS authorName, rating, comment, created_at AS createdAt
    FROM reviews WHERE worker_id = ? ORDER BY created_at DESC
  `).all(workerId);
}

module.exports = {
  WorkerServiceError,
  listSkills,
  listEquipment,
  listCities,
  createWorker,
  getWorker,
  searchWorkers,
  updateWorker,
  deleteWorker,
  priceCheck,
  addReview,
  listReviews,
};
