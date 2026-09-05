# HandyNeighbors

A free, ad-free marketplace for individual handymen — post what you fix, what
equipment you own, and your hourly rate; neighbors search, compare local
prices, and contact you directly to hire.

## Why this project

Every existing home-services platform picks one of two shapes: a lead-seller
that charges contractors per inquiry and hides pricing (Angi, HomeAdvisor),
or a fee-taking marketplace that lists companies as often as individuals
(Thumbtack, TaskRabbit). Neither shows what a job actually costs before you
call anyone, and neither is free for the person doing the work.

HandyNeighbors is deliberately narrow instead:

- **Individuals only, no companies.** There's no "business name" field. A
  listing is one person, their own skills, their own rate.
- **Handymen only, on purpose.** Skills are capped to a curated list of
  tasks that don't require a state trade license (drywall, painting,
  fixture swaps, assembly, minor repairs) — no licensing/insurance
  verification system to build or maintain.
- **Free to post, no commission, no lead fees.** Posting a listing costs
  nothing and always will; the plan for revenue later is ads (Duolingo-style),
  not a cut of anyone's job. There are no ads in this build.
- **A real price-matching engine.** `/api/price-check` aggregates every
  listed rate for a skill (optionally narrowed to a city/state) into a
  low/median/average/high, so both sides can see if a rate is in line with
  the local market — something none of the incumbents expose.
- **Built around city, not just as a filter field.** The Find tab opens on
  a row of city chips (headcount + average rate per city, from
  `/api/cities`) so browsing starts local by default, the way the actual
  demand for a handyman is local; picking one narrows search and updates
  the URL so a specific city's results are a shareable link.
- **Equipment is typed, not a flat tag cloud.** Every equipment item belongs
  to a category (Access & Transport, Power Tools, Diagnostic & Specialty,
  General & Finishing) seeded in `src/db.js`. The post form groups
  checkboxes by category, and both search cards and a worker's profile show
  equipment grouped the same way — so "does this person have a truck" reads
  at a glance instead of getting lost among sixteen tags.
- **Never touches money.** The platform stores no payment info and runs no
  escrow. Contact info is shown on a worker's profile and the job (and the
  payment) is arranged directly between the two people. That keeps
  HandyNeighbors a directory + marketplace, not an employer, contractor, or
  financial service — see *Design notes* below for why that distinction
  matters legally.
- **Real accounts, not anonymous free text.** Posting a listing or leaving a
  review requires a signed-in, verified account — passwords are hashed
  with `scrypt` (Node's own `crypto`, no extra dependency), sessions are
  random tokens whose hash (not the token itself) lives in the database,
  and a "Verified" badge means the account's email is confirmed. One
  review per account per listing, and you can't review your own.
- **Self-service data deletion.** Every table that references an account
  cascades on delete, so "Delete account" in the header actually removes
  it — and every listing and review it owns — in one step, no support
  ticket required.

## Tech stack

| Layer      | Choice                                      |
|------------|----------------------------------------------|
| Runtime    | Node.js (>=22.13)                            |
| Server     | Express                                      |
| Database   | SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) — no separate native dependency |
| Frontend   | Static HTML/CSS/vanilla JS (no build tooling, no CDN dependencies) |
| Testing    | Node's built-in `node:test` + `node:assert`  |

## Project structure

```
src/
  db.js             # opens/initializes SQLite; seeds the fixed skill/equipment lists
  workerService.js   # core domain logic: validation, search, price-matching, reviews
  authService.js      # signup/login/sessions/email verification, password hashing
  emailSender.js       # pluggable verification email delivery (real provider or dev-log)
  server.js          # Express app + route wiring; createApp() is test-friendly
public/
  index.html         # Find / Price Check / List Your Services tabs, auth UI
  style.css
  app.js             # fetch() calls against the JSON API, no framework
  terms.html, privacy.html   # Terms of Service / Privacy Policy
  verify-email.html, verify-email.js  # the page a verification link opens
test/
  workerService.test.js  # unit tests against the service layer directly
  authService.test.js     # unit tests: signup, login, sessions, verification, deletion
  server.test.js         # integration tests against a real HTTP server
docs/
  index.html, style.css, app.js  # a static build for GitHub Pages — see below
```

## Live, shared version (real backend, public to anyone)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Samuel8M/HandyNeighbors-Marketplace)

`render.yaml` in this repo is a one-click Render blueprint for the actual
Express + SQLite app in `src/` — the real shared backend, not the
localStorage demo below. Click the button, sign in with GitHub (no credit
card needed for Render's free web-service plan at time of writing — verify
current terms at signup), and it deploys straight from this repo. Two
honest limits of the free plan worth knowing: the disk is ephemeral, so
data resets on every redeploy or restart, and the service spins down after
15 minutes idle and takes ~30 seconds to wake back up on the next request.
Fine for a demo anyone can reach; for real persistence, swap in a managed
Postgres/SQLite service (e.g. Render's paid disks, or Turso) later.

**Email verification.** Without `RESEND_API_KEY` set as an environment
variable, verification links aren't actually emailed — the API hands the
link back directly (clearly marked `mode: "dev-log"`) and the frontend
offers to verify the account with it right there, so the whole flow stays
testable without a connected email account. Set `RESEND_API_KEY` (and
optionally `EMAIL_FROM`) to send real email through
[Resend](https://resend.com) — see `src/emailSender.js`. This live
deployment has one configured, and delivery is confirmed working
end-to-end (signup → real email → click → verified). Two things worth
knowing about the unverified default sender (`onboarding@resend.dev`):
it lands in spam more often than a verified domain would, and per
Resend's anti-spam rules it can only deliver to the email address the
Resend *account itself* is registered with — not arbitrary signups.
Verifying your own domain in Resend removes both limits.

**Why this runs on `node:sqlite` instead of `better-sqlite3`:** the first
deploy attempt segfaulted immediately on start (`Segmentation fault (core
dumped)`, exit 139) — every time, on every Node version and cache state
tried. A plain Node process with no database code ran fine on the same
Render instance, which isolated it conclusively to `better-sqlite3`'s
compiled native binary being incompatible with that specific host,
regardless of whether it came from a prebuilt download or a from-source
`node-gyp` build. Since `node:sqlite` (`DatabaseSync`) is compiled and
shipped by the Node project itself as part of the Node binary — no
separate native artifact to mismatch the host — switching to it removed
the problem at the root instead of continuing to chase environment-specific
binary theories. See `src/db.js` for the migration notes, including the
one real behavioral difference from `better-sqlite3` (no `.transaction()`
helper; `db.js` exports a small `withTransaction()` in its place).

## Live demo (static build)

**https://samuel8m.github.io/HandyNeighbors-Marketplace/**

`docs/` is a separate, self-contained build of the same UI for GitHub Pages,
which only serves static files and can't run the Express/SQLite backend
above. It's the same HTML/CSS, with `app.js` rewritten to read and write
`localStorage` instead of calling the API — no server, no shared data
between visitors, seeded with a few example listings on first load. It's a
demo of the interface, not the product: edit-token security, a real shared
database, and the full test suite only exist in the Express version. Once
GitHub Pages is enabled for this repo (Settings → Pages → deploy from
`main` / `docs`), it's served free, permanently, straight from the repo.

## Android app (Google Play)

`android/` is a real Android app wrapping the live site as a **Trusted Web
Activity (TWA)** — Google's own supported way to ship a website to the Play
Store as a full-screen app with no browser address bar, not a rewrite in a
different framework. `public/.well-known/assetlinks.json` is what makes the
address bar actually disappear: it's a Digital Asset Links statement
proving this exact app (package `com.handyneighbors.app`, tied to the
release signing key's certificate fingerprint) is authorized to open this
site's links, and it's confirmed resolving correctly via Google's own
verification API (`digitalassetlinks.googleapis.com`).

The project was generated with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
(`android/twa-manifest.json` is its config), built with Gradle
(`bundleRelease`), and signed with `jarsigner` into a release `.aab` — the
format Play Console requires. `android/generate-project.js` is the one-off
script used to generate the project non-interactively (Bubblewrap's CLI
wizard has no scripted mode); it's not meant to be run again once the
project and signing key exist. **The signing keystore itself is
deliberately not committed** (see `android/.gitignore`) — whoever holds it
controls all future updates to this app on the Play Store, so it needs to
live somewhere private and durable instead, not in a public repo's history.

What's left is Play Console itself, which needs a real person: a Google
Play Console developer account (one-time $25 fee, identity verification),
the store listing (description, real device screenshots, content rating
questionnaire), and uploading the `.aab`. The Privacy Policy URL Play
Console asks for is already live: `https://handyneighbors.onrender.com/privacy.html`.

## Getting started

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (override with `PORT`) and
creates a SQLite file at `data/handyneighbors.db` on first run.

## API reference

Auth is a session cookie (`hn_session`, HttpOnly, SameSite=Lax), set by
signup/login and read on every request — no `Authorization` header to
manage client-side.

| Method | Path                          | Description |
|--------|--------------------------------|--------------|
| POST   | `/api/auth/signup`             | `{ email, password (8+ chars), name, acceptedTerms: true }`. Creates the account, signs you in, and sends (or dev-logs) a verification email. `409` on a duplicate email. |
| POST   | `/api/auth/login`               | `{ email, password }`. `401` for either a wrong email or wrong password (same message either way, so one can't be used to enumerate accounts). |
| POST   | `/api/auth/logout`               | Destroys the current session. |
| GET    | `/api/auth/me`                   | `{ user }` for the signed-in account, or `{ user: null }`. |
| GET    | `/api/auth/verify-email`         | Query param `token`. Marks the account verified; the link a verification email points to. |
| POST   | `/api/auth/resend-verification`  | Requires auth. Issues a fresh verification token/email. |
| DELETE | `/api/auth/me`                   | Requires auth. Deletes the account and, via cascade, every listing/review/session it owns. |
| GET    | `/api/skills`                    | The fixed list of handyman skills (slug + name). |
| GET    | `/api/equipment`                 | The fixed list of equipment tags, each with a `category`. |
| GET    | `/api/cities`                    | Every city/state with at least one listing: `workerCount` and `averageRate`, most-active-first. Powers the "Browse by City" strip. |
| POST   | `/api/workers`                   | Requires auth + a verified email. Creates a listing owned by the signed-in account. |
| GET    | `/api/workers`                   | Public. Search. Query params: `skill`, `equipment`, `city`, `state`, `minRate`, `maxRate`, `q`, `sortBy` (`newest` \| `rate_asc` \| `rate_desc` \| `rating_desc`). |
| GET    | `/api/workers/:id`                | Public. One worker's full profile: skills, equipment, rating, `verified`, `memberSince`, `ownerId`. |
| PUT    | `/api/workers/:id`                | Requires auth. `403` unless you own the listing. |
| DELETE | `/api/workers/:id`                | Requires auth. `403` unless you own the listing. |
| GET    | `/api/price-check`                | Public. Query params: `skill` (required), `city`, `state`. Returns `count`, `low`, `median`, `average`, `high`, and the matching workers sorted by rate. |
| GET    | `/api/workers/:id/reviews`        | Public. List reviews for a worker. |
| POST   | `/api/workers/:id/reviews`        | Requires auth + a verified email + not suspended. `{ rating (1-5), comment? }` — the reviewer's name comes from their account, not free text. `400` on reviewing your own listing, `409` on a second review of the same listing. |
| POST   | `/api/reports`                    | Requires auth + a verified email. `{ targetType: 'worker' \| 'review', targetId, reason, details? }`. `reason` is one of `spam`, `scam_or_fraud`, `inappropriate_content`, `harassment`, `fake_listing`, `other`. `400` on reporting your own content. |
| GET    | `/api/admin/reports`              | Admin only (`403` otherwise). Optional `?status=open\|dismissed\|actioned`. |
| POST   | `/api/admin/reports/:id/action`   | Admin only. `{ action: 'dismiss' \| 'delete_content' \| 'ban_user' \| 'delete_and_ban' }`. |
| GET    | `/api/admin/banned-users`         | Admin only. Currently-suspended accounts. |
| POST   | `/api/admin/banned-users/:id/unban` | Admin only. Lifts a suspension. |
| GET    | `/health`                         | Liveness check. |

## Content moderation (reports, bans, and the admin console)

Every listing and review can be flagged by any other signed-in, verified
account (a "Report" link on the listing and on each review). A flag never
takes any action by itself — it lands in a queue at **`/admin.html`**,
visible only to accounts whose email is listed in the `ADMIN_EMAILS` env
var (comma-separated; see `authService.syncAdminFlag` — there's no signup
flag or API call that grants admin, so listing an address there is the
only way in). From that queue an admin can dismiss a report, delete the
reported content, suspend the account behind it (`requireNotBanned` in
`server.js` then blocks that account from posting listings or leaving
reviews — they can still sign in, browse, and delete their own account),
or both at once.

This is what backs Google Play's Content Ratings "User Content Sharing"
questions (reporting and blocking user-generated content) — see
`src/moderationService.js` for the reason/action vocabulary.

## Running the tests

```bash
npm test
```

50 tests: service-level unit tests against an in-memory database (worker
validation, search filters and sorting, city aggregation, price-matching
math, ownership enforcement, reports/moderation actions) and against
`authService` directly (signup validation, login, sessions, email
verification, account deletion), plus HTTP integration tests exercising
the full signup → verify → post → search → price-check → review → update
→ delete → delete-account lifecycle, reporting content, and the
admin-only moderation routes (gated by `ADMIN_EMAILS`) — cookies,
ownership, and rate limiting included — through a real Express server.

## Design notes / trade-offs

- **Handymen only, no license verification.** Skilled trades like plumbing
  and electrical are excluded from the skill list on purpose. Verifying
  licenses/insurance is a real product (and legal) undertaking; staying in
  the unlicensed handyman lane sidesteps it entirely for this MVP.
- **No payment processing.** The platform never collects, holds, or
  transmits money. This is a deliberate legal boundary, not just a
  simplicity shortcut: a platform that holds funds between two parties can
  end up classified as an escrow agent, contractor, or employer, which
  triggers a different set of obligations (financial licensing, tax
  withholding, workers' comp) than a plain directory carries. Workers here
  are independent listers, not employees or contractors of the platform —
  the footer disclaimer on every page says so. (This is a design choice
  informed by general research, not legal advice; run the actual Terms of
  Service and worker/user agreements past a real lawyer before taking this
  live.)
- **Accounts, sessions, and passwords — all via Node's own `crypto`.**
  Passwords are hashed with `scrypt` (a random 16-byte salt per user,
  64-byte derived key, stored as `scrypt:<saltHex>:<hashHex>` so the
  scheme is self-describing if it ever changes) and compared with
  `crypto.timingSafeEqual`. Sessions are the same shape the old edit-token
  model used: a `crypto.randomBytes(32)` token goes to the browser as an
  HttpOnly, SameSite=Lax cookie, and only its SHA-256 hash is ever stored
  — the database never holds a credential usable on its own. No
  dependency (bcrypt, argon2, express-session) was needed for any of this.
- **Email verification is real infrastructure with a pluggable last mile.**
  Tokens, expiry (24h), and the "must be verified to post/review" gate are
  all real and tested. What's pluggable is delivery: `src/emailSender.js`
  sends through Resend if `RESEND_API_KEY` is set, and otherwise logs the
  link and returns it in the API response instead of pretending to have
  sent an email nobody can read — see *Live, shared version* above.
- **A rate limiter and security headers, hand-rolled instead of two more
  dependencies.** `/api/auth/login` and `/api/auth/signup` are capped at 20
  attempts per 15 minutes per IP via an in-memory `Map` — the right amount
  of machinery for a single free-tier instance; a real multi-instance
  deployment would swap the store, not the API. Response headers
  (`X-Frame-Options`, `X-Content-Type-Options`, a `Content-Security-Policy`
  with no `'unsafe-inline'` for scripts) are ~15 lines instead of adding
  `helmet` for a page with this few moving parts.
- **A fixed skill/equipment vocabulary, not free text.** Search and the
  price-matching engine both depend on every worker picking from the same
  list of skills and equipment (seeded in `src/db.js`). Free-text tags
  would fragment ("faucet fix" vs "fix a faucet") and make both search and
  price aggregation unreliable. Equipment additionally carries a
  `category` column so the vocabulary stays browsable as it grows — a flat
  list of 16 checkboxes is already borderline; grouped, it scales past 40
  or 50 without becoming a wall of text.
- **City aggregation lives in SQL, sorting doesn't.** `/api/cities` is a
  single `GROUP BY` query — cheap and correct at any size. Search results,
  by contrast, are sorted in JS after fetching (`newest` — the SQL order —
  is free; `rate_asc`/`rate_desc`/`rating_desc` re-sort the already-small
  result set). Rating in particular is computed per-worker from the
  `reviews` table, not stored on `workers`, so it isn't available to an SQL
  `ORDER BY` without a join+aggregate on every search; fine at this scale,
  worth revisiting if result sets ever get large.
- **SQLite over Postgres/Mongo**: this is a single-process, portfolio-scale
  app — `node:sqlite` gives a real relational database with zero external
  services and zero extra dependencies to install or configure, while
  still exercising SQL, indexes, and foreign keys.
- **No ads, no CDN scripts.** The whole frontend is inline-dependency-free
  HTML/CSS/vanilla JS served straight out of `public/` — nothing to build,
  bundle, or fetch from a third party. Monetization (ads) is explicitly
  deferred, per the "free like Duolingo, ad-free to start" brief.
