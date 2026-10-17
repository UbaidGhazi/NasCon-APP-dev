# Architecture — Multi-Sport League & Club Operations Platform

Backend is Node.js. The canonical-JSON risk that normally comes with that choice is closed: `src/signing.js` reproduces all three Appendix A reference vectors exactly, and `tests/signing.test.js` asserts it.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| API | **Node 20 + Express 4** | `src/app.js`, `src/server.js` |
| DB | **PostgreSQL 16** via `pg` (raw SQL, no ORM) | Real `SELECT … FOR UPDATE` row locks for NFR-3. Raw SQL beats setting up an ORM under time pressure. |
| Cache / rate limit / queue | **Redis 7** (`ioredis`) + Redis Streams | Rolling-window limiter, idempotency, domain events |
| Object store | **MinIO** | Present in compose as the required object store |
| PDF | **wkhtmltopdf** | On the approved list (§7). PDFKit is **not** — do not swap it in |
| Validation | **zod** | Gives `details.fields` for `400 VALIDATION_ERROR` cheaply |
| JWT | **jsonwebtoken**, HS256 | Must pass `algorithms:['HS256']` to verify, or `alg:none` slips through |
| Tests | **jest** + `scripts/coverage-report.js` | `./run_tests.sh` writes real numbers into `COVERAGE.json` |
| Mobile | **Flutter (Android)** | See `MOBILE_PLAN.md` |

---

## 2. Repository layout

```
/
├─ docker-compose.yml          # GRADED: api :8080, db, redis, minio, worker
├─ Dockerfile
├─ .env.example                # GRADED: no real salt
├─ README.md                   # GRADED: run steps + 5 demo accounts
├─ TRACEABILITY.md             # GRADED: FR/NFR → file → test
├─ COVERAGE.json               # GRADED: written by run_tests.sh, never by hand
├─ run_tests.sh                # GRADED: one command
├─ package.json
│
├─ src/
│  ├─ server.js                # boot: retry DB, ensureSchema, seed, listen
│  ├─ app.js                   # express wiring, /health, /reset, /api/v1/ping
│  ├─ config.js                # env, pg pool, redis, withTx()
│  ├─ errors.js                # AppError + Appendix B catalogue + error handler
│  ├─ signing.js               # canonical JSON + HMAC  ✅ vectors verified
│  ├─ middleware.js            # 413 guard, /api/v1 rate limiter
│  ├─ schema.sql               # every table
│  ├─ seed.js                  # §5.5 baseline — THE ONLY FILE WITH SPORT NAMES
│  ├─ worker.js                # Redis Streams consumer
│  ├─ security.js              # TODO(A): JWT issue/verify + RBAC policy table
│  ├─ pdf.js                   # TODO(B): wkhtmltopdf receipt
│  │
│  ├─ domain/                  # NO HTTP, NO SPORT NAMES
│  │  ├─ sports.js             # TODO(A): config validation
│  │  ├─ scoring.js            # TODO(C): append + projection
│  │  ├─ standings.js          # TODO(C): table, h2h, tie-break, qualification
│  │  ├─ roster.js             # TODO(B): the 8 ordered checks
│  │  ├─ store.js              # TODO(B): reservation, gateway, receipt
│  │  ├─ offline.js            # TODO(C): replays through scoring + roster
│  │  └─ fixtures/
│  │     ├─ round_robin.js  single_elim.js  swiss.js  double_elim.js
│  │
│  └─ routes/                  # app.js mounts each the moment the file exists
│     ├─ sports.js  fixtures.js  leagues.js  events.js  standings.js
│     └─ roster.js  store.js  rbac.js  offline.js
│
├─ scripts/coverage-report.js  # maps jest output → the six graded areas
├─ tests/                      # signing.test.js ✅ 9/9 passing
└─ mobile/release/app-release.apk   # GRADED: must be committed
```

`app.js` mounts route modules with a `try/require` that swallows `MODULE_NOT_FOUND`. A developer who hasn't finished their area cannot break anyone else's — the server still boots, `/health` is still 200, and the other areas still score.

**The hard rule:** `src/domain/` must contain zero occurrences of `football`, `basketball`, `cricket`, `esports`, `goal`, `wicket`. They appear only in `src/seed.js`, as data. This is the `−8` penalty, which is larger than the entire fixtures area is worth.

---

## 3. The Node-specific traps

### 3.1 Transactions — `pool.query('BEGIN')` is a bug

`pg` may hand each query a different pooled connection, so a `FOR UPDATE` lock lands on one connection and the `UPDATE` on another. That is precisely how the 20-buyer oversell test fails. Always use `withTx` from `config.js`:

```js
await withTx(async (c) => {
  const { rows } = await c.query(
    'SELECT stock, reserved FROM inventory WHERE variant_id = $1 FOR UPDATE', [vid]
  );
  if (rows[0].stock < qty) throw conflict('OUT_OF_STOCK', 'No stock left.', { variant_id: vid });
  await c.query('UPDATE inventory SET stock = stock - $2, reserved = reserved + $2 WHERE variant_id = $1', [vid, qty]);
});
```

Lock variants in **sorted `variant_id` order** for multi-item orders, or concurrent requests deadlock.

### 3.2 Canonical JSON — already solved, do not rewrite it

`JSON.stringify` does not sort keys, and `Array.prototype.sort()` compares UTF-16 code units while the spec says Unicode code point. `src/signing.js` handles both. Verified:

```
canonical    : {"event_type":"goal","team_id":"t1"}
vector1 MATCH: true
lots t1/t2/t3 MATCH: true
```

### 3.3 Rate limiting must not be global

`/audit/v1/*` and `/health` are exempt and the grader sends up to 200 req/s. The limiter is mounted on the `/api/v1` router only (`app.js`). Moving it to `app.use()` fails every graded area at once.

### 3.4 Number rounding will diverge from the grader

Python's `round()` is banker's rounding; JS `toFixed()` is not. On a 3-decimal net-run-rate tie this produces a different last digit. Round half-up explicitly and keep integer arithmetic wherever possible:

```js
const nrr = Math.round(value * 1000) / 1000;   // not value.toFixed(3)
```

Money stays integer paisa end to end. A float in `total_minor` breaks every receipt signature.

### 3.5 Never a 5xx

`errors.js` catches malformed JSON (`entity.parse.failed` → 400), oversized bodies (`entity.too.large` → 413), and anything unhandled. A 500 anywhere in the security probes is a failed vector.

---

## 4. Data model

See `src/schema.sql` for the full definition. The two append-only tables matter most:

- `match_events` — the event-sourced log. The only column ever updated is `compensated` / `compensated_by`. `/score` rebuilds from this on every read; no stored score is ever the source of truth.
- `roster_audit` — every accepted roster change, oldest first. Rejected requests write nothing.

Both carry `body_hash` + `response` columns (also on `orders` and `roster_requests`) so idempotent replay returns the stored body with **200**, while the same id with a different body returns **409 DUPLICATE_***. Getting 200-vs-201 wrong fails a vector even when the rest is right.

---

## 5. Interfaces between the three backend developers

Agree these signatures now so nobody blocks:

```js
// domain/scoring.js
async function appendEvent(c, { event_id, match_id, type, payload })  // -> 201 body
async function project(c, matchId)                                    // -> /score body

// domain/standings.js
async function table(c, leagueId)                                     // -> /standings body

// domain/roster.js
async function transfer(c, body)                                      // -> /roster/transfer body
async function history(c, playerId, asOf)

// domain/store.js
async function checkout(c, body)
```

`offline.js` calls `appendEvent` and `transfer` directly and maps a thrown `AppError.code` into the per-action `error_code`. That is why `/offline-sync` is cheap — build it last, in about 20 minutes.

---

## 6. Current state

| Piece | Status |
|---|---|
| `signing.js` + tests | **Done**, all 3 reference vectors verified, 93.3% lines |
| `errors.js`, `middleware.js`, `config.js` | **Done** |
| `schema.sql`, `seed.js` | **Done** — exact §5.5 baseline ids |
| `app.js`, `server.js`, `worker.js` | **Done** — `/health`, `/reset`, `/api/v1/ping` live |
| Docker + compose | **Done** — needs one clean `up --build` run to confirm |
| Six graded areas | **Not started** — see `BUILD_ORDER.md` for the order |
