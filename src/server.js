'use strict';

const path = require('path');
const express = require('express');

const { createDb } = require('./db');
const svc = require('./workerService');
const authSvc = require('./authService');
const { createEmailSender } = require('./emailSender');
const { WorkerServiceError } = svc;
const { AuthError } = authSvc;

const SESSION_COOKIE = 'hn_session';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

function setSessionCookie(req, res, session) {
  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    expires: new Date(session.expiresAt),
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// A handful of common response headers that cost nothing to set and rule
// out a few whole classes of attack (clickjacking, MIME-sniffing) without
// pulling in a dependency (e.g. helmet) for what's ~10 lines here. script-src
// is strict (no inline/eval); style-src allows 'unsafe-inline' because the
// frontend sets a few inline `style="width:...%"` attributes (the price
// chart bar, mainly) — inline styles are lower-risk than inline scripts,
// so that's a deliberate, narrower exception, not a blanket one.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  next();
}

// A simple fixed-window limiter, in memory. That's the right amount of
// machinery for a single-instance, free-tier app — it resets if the
// process restarts, and doesn't share state across instances, but a real
// multi-instance deployment would swap this for a shared store (e.g.
// Redis) rather than needing a different API.
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      return res.status(429).json({ error: message });
    }
    entry.count += 1;
    next();
  };
}

/**
 * Builds a fully wired Express app around a given database handle.
 * Separated from bootstrap() so tests can build an app around an
 * in-memory DB.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sendVerificationEmail?: (email: string, verifyUrl: string) => Promise<object> }} [options]
 */
function createApp(db, options = {}) {
  const app = express();
  const sendVerificationEmail = options.sendVerificationEmail || createEmailSender();

  // Render (and most PaaS hosts) terminate TLS at a proxy and forward
  // plain HTTP internally — without this, req.secure is always false
  // there, and secure cookies would silently never get set.
  app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(express.json());
  // Mounted separately (not just left to the plain static() below) because
  // express.static defaults to ignoring any path with a dotfile segment —
  // '.well-known' would 404 otherwise. Needed for assetlinks.json, which
  // proves this site authorizes the Android app (see android/README.md)
  // to open its links without a browser address bar.
  app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Resolves the session cookie (if any) into req.user for every route.
  // req.user is null, not an error, when no one is signed in — routes
  // that need a signed-in user check for that explicitly via requireAuth.
  app.use((req, res, next) => {
    req.user = authSvc.resolveSession(db, getSessionToken(req));
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Sign in to do that.' });
    next();
  }

  function requireVerified(req, res, next) {
    if (!req.user.emailVerified) {
      return res.status(403).json({
        error: 'Verify your email first — check your inbox for the link, or resend it from your account.',
      });
    }
    next();
  }

  const authRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts — try again in a few minutes.',
  });

  function verifyUrlFor(req, token) {
    return `${req.protocol}://${req.get('host')}/verify-email.html?token=${encodeURIComponent(token)}`;
  }

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // ---------- Auth ----------

  app.post('/api/auth/signup', authRateLimiter, async (req, res, next) => {
    try {
      const result = await authSvc.signup(db, req.body || {}, (email, token) => sendVerificationEmail(email, verifyUrlFor(req, token)));
      setSessionCookie(req, res, result.session);
      res.status(201).json({ user: result.user, verification: result.verification });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login', authRateLimiter, (req, res, next) => {
    try {
      const result = authSvc.login(db, req.body || {});
      setSessionCookie(req, res, result.session);
      res.json({ user: result.user });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    authSvc.destroySession(db, getSessionToken(req));
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user });
  });

  // Deletes the account and, via ON DELETE CASCADE, every listing,
  // review, and session it owns — the self-service right-to-erasure this
  // app's Privacy Policy promises.
  app.delete('/api/auth/me', requireAuth, (req, res) => {
    authSvc.deleteAccount(db, req.user.id);
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/auth/verify-email', (req, res, next) => {
    try {
      const user = authSvc.verifyEmail(db, req.query.token);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/resend-verification', requireAuth, authRateLimiter, async (req, res, next) => {
    try {
      const verification = await authSvc.resendVerification(db, req.user.id, (email, token) => sendVerificationEmail(email, verifyUrlFor(req, token)));
      res.json({ verification });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Lookups ----------

  app.get('/api/skills', (req, res) => {
    res.json(svc.listSkills(db));
  });

  app.get('/api/equipment', (req, res) => {
    res.json(svc.listEquipment(db));
  });

  // Powers "Browse by City": every city/state with at least one listing,
  // with a headcount and average rate, most-active-first.
  app.get('/api/cities', (req, res) => {
    res.json(svc.listCities(db));
  });

  // ---------- Workers ----------
  // Browsing (search/get/reviews/price-check) is public — HandyNeighbors
  // stays free to browse. Posting, editing, and reviewing require a
  // verified account, so a listing and its reviews are tied to a real,
  // (email-)verified person rather than anonymous free text.

  app.post('/api/workers', requireAuth, requireVerified, (req, res, next) => {
    try {
      const worker = svc.createWorker(db, req.user.id, req.body || {});
      res.status(201).json({ worker });
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

  app.put('/api/workers/:id', requireAuth, (req, res, next) => {
    try {
      res.json(svc.updateWorker(db, req.user.id, req.params.id, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/workers/:id', requireAuth, (req, res, next) => {
    try {
      svc.deleteWorker(db, req.user.id, req.params.id);
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

  app.post('/api/workers/:id/reviews', requireAuth, requireVerified, (req, res, next) => {
    try {
      res.status(201).json(svc.addReview(db, req.user.id, req.params.id, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  // Centralized error handling: WorkerServiceError/AuthError carry a
  // client-safe status + message; anything else is an unexpected 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof WorkerServiceError || err instanceof AuthError) {
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
