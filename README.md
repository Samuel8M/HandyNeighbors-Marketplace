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
- **Never touches money.** The platform stores no payment info and runs no
  escrow. Contact info is shown on a worker's profile and the job (and the
  payment) is arranged directly between the two people. That keeps
  HandyNeighbors a directory + marketplace, not an employer, contractor, or
  financial service — see *Design notes* below for why that distinction
  matters legally.
- **No accounts, no passwords.** Posting a listing returns a one-time edit
  token (shown once) that's required to update or delete it later. Nothing
  to remember, nothing to store insecurely.

## Tech stack

| Layer      | Choice                                      |
|------------|----------------------------------------------|
| Runtime    | Node.js (>=18)                               |
| Server     | Express                                      |
| Database   | SQLite via `better-sqlite3` (file-based, zero setup, synchronous API) |
| Frontend   | Static HTML/CSS/vanilla JS (no build tooling, no CDN dependencies) |
| Testing    | Node's built-in `node:test` + `node:assert`  |

## Project structure

```
src/
  db.js             # opens/initializes SQLite; seeds the fixed skill/equipment lists
  workerService.js   # core domain logic: validation, search, price-matching, reviews
  server.js          # Express app + route wiring; createApp() is test-friendly
public/
  index.html         # Find / Price Check / List Your Services tabs
  style.css
  app.js             # fetch() calls against the JSON API, no framework
test/
  workerService.test.js  # unit tests against the service layer directly
  server.test.js         # integration tests against a real HTTP server
```

## Getting started

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (override with `PORT`) and
creates a SQLite file at `data/handyneighbors.db` on first run.

## API reference

| Method | Path                          | Description |
|--------|--------------------------------|--------------|
| GET    | `/api/skills`                  | The fixed list of handyman skills (slug + name). |
| GET    | `/api/equipment`                | The fixed list of equipment tags. |
| POST   | `/api/workers`                  | Create a listing. Returns `{ worker, editToken }` — the token is shown once. |
| GET    | `/api/workers`                  | Search. Query params: `skill`, `equipment`, `city`, `state`, `minRate`, `maxRate`, `q`. |
| GET    | `/api/workers/:id`              | One worker's full profile, including skills, equipment, and rating. |
| PUT    | `/api/workers/:id`               | Update a listing. Requires header `X-Edit-Token`. |
| DELETE | `/api/workers/:id`               | Remove a listing. Requires header `X-Edit-Token`. |
| GET    | `/api/price-check`               | Query params: `skill` (required), `city`, `state`. Returns `count`, `low`, `median`, `average`, `high`, and the matching workers sorted by rate. |
| GET    | `/api/workers/:id/reviews`       | List reviews for a worker. |
| POST   | `/api/workers/:id/reviews`       | Add a review: `{ authorName, rating (1-5), comment? }`. |
| GET    | `/health`                        | Liveness check. |

## Running the tests

```bash
npm test
```

17 tests: service-level unit tests against an in-memory database (validation,
search filters, price-matching math, edit-token enforcement), plus HTTP
integration tests exercising the full create → search → price-check →
review → update → delete lifecycle through a real Express server.

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
- **One-time edit tokens instead of accounts.** No email/password auth to
  build, salt, hash, reset, or leak. The token is generated with
  `crypto.randomBytes(24)`, and only its SHA-256 hash is stored — compared
  with `crypto.timingSafeEqual` — so the database never holds a usable
  credential.
- **A fixed skill/equipment vocabulary, not free text.** Search and the
  price-matching engine both depend on every worker picking from the same
  list of skills and equipment (seeded in `src/db.js`). Free-text tags
  would fragment ("faucet fix" vs "fix a faucet") and make both search and
  price aggregation unreliable.
- **SQLite over Postgres/Mongo**: this is a single-process, portfolio-scale
  app — `better-sqlite3` gives a real relational database with zero
  external services to install or configure, while still exercising SQL,
  indexes, and foreign keys.
- **No ads, no CDN scripts.** The whole frontend is inline-dependency-free
  HTML/CSS/vanilla JS served straight out of `public/` — nothing to build,
  bundle, or fetch from a third party. Monetization (ads) is explicitly
  deferred, per the "free like Duolingo, ad-free to start" brief.
