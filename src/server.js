'use strict';

const path = require('path');
const express = require('express');

const { createDb } = require('./db');
const svc = require('./workerService');
const { WorkerServiceError } = svc;

/**
 * Builds a fully wired Express app around a given database handle.
 * Separated from bootstrap() so tests can build an app around an
 * in-memory DB.
 *
 * @param {import('better-sqlite3').Database} db
 */
function createApp(db) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/skills', (req, res) => {
    res.json(svc.listSkills(db));
  });

  app.get('/api/equipment', (req, res) => {
    res.json(svc.listEquipment(db));
  });

  // Free to post, no account required: a worker gets back an edit token
  // once, at creation time, and must hold onto it to edit or remove the
  // listing later. HandyNeighbors never touches payment — contact info is
  // just shown on the profile so the user and worker arrange it directly.
  app.post('/api/workers', (req, res, next) => {
    try {
      const { worker, editToken } = svc.createWorker(db, req.body || {});
      res.status(201).json({ worker, editToken });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/workers', (req, res, next) => {
    try {
      res.json(svc.searchWorkers(db, req.query));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/workers/:id', (req, res, next) => {
    try {
      res.json(svc.getWorker(db, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/workers/:id', (req, res, next) => {
    try {
      const editToken = req.get('X-Edit-Token');
      res.json(svc.updateWorker(db, req.params.id, editToken, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/workers/:id', (req, res, next) => {
    try {
      const editToken = req.get('X-Edit-Token');
      svc.deleteWorker(db, req.params.id, editToken);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/price-check', (req, res, next) => {
    try {
      res.json(svc.priceCheck(db, req.query));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/workers/:id/reviews', (req, res, next) => {
    try {
      res.json(svc.listReviews(db, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/workers/:id/reviews', (req, res, next) => {
    try {
      res.status(201).json(svc.addReview(db, req.params.id, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  // Centralized error handling: WorkerServiceError carries a client-safe
  // status + message; anything else is an unexpected 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof WorkerServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function bootstrap() {
  const dataDir = path.join(__dirname, '..', 'data');
  require('fs').mkdirSync(dataDir, { recursive: true });
  const db = createDb(path.join(dataDir, 'handyneighbors.db'));
  const app = createApp(db);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`HandyNeighbors listening on http://localhost:${port}`);
  });
  return app;
}

if (require.main === module) {
  bootstrap();
}

module.exports = { createApp, bootstrap };
