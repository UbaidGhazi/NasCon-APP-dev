# Multi-Sport League & Club Operations Platform

NaSCon '26 App Dev Competition — Phase I submission.

Backend: Node.js 20 · Express · PostgreSQL 16 · Redis 7 · MinIO · wkhtmltopdf
Mobile: Flutter (Android), offline-tolerant with a persistent local action queue.

---

## Run the backend

Requires Docker Engine 24+ with Compose v2. Nothing else.

```bash
DAY1_SALT=<team-salt> docker compose up -d --build
```

The API listens on `http://localhost:8080`. Readiness:

```bash
curl -s http://localhost:8080/health     # {"status":"ok"}
```

`/health` returns 200 only once the database is reachable **and** baseline data is seeded.

Reset to the baseline state at any time:

```bash
curl -s -X POST http://localhost:8080/audit/v1/reset \
     -H 'Content-Type: application/json' -d '{"seed":42}'
```

`DAY1_SALT` is read from the environment at startup only. It is never committed and never hard-coded.

### Services

| Service | Port | Role |
|---|---|---|
| `api` | 8080 | REST + realtime layer |
| `db` | 5432 | PostgreSQL 16 |
| `redis` | 6379 | Cache, rate limiting, Redis Streams queue |
| `minio` | 9000 | Object store |
| `worker` | — | Consumes domain events from Redis Streams |

---

## Run the tests

```bash
./run_tests.sh
```

Runs jest with coverage and regenerates `COVERAGE.json` (real line coverage per graded backend area — the script writes the measured numbers, never hand-typed ones).

---

## Demo accounts

Present after every startup and every `POST /audit/v1/reset`.

| Role | Email | Password |
|---|---|---|
| Platform Super-Admin | `admin@nascon.test` | `Nascon@26` |
| League Organizer (owns `league-alpha-1`) | `organizer@nascon.test` | `Nascon@26` |
| Club Manager (owns `club-alpha-1`) | `manager@nascon.test` | `Nascon@26` |
| Player (`player-alpha-1`) | `player@nascon.test` | `Nascon@26` |
| General Viewer | `viewer@nascon.test` | `Nascon@26` |

---

## Mobile app

Built APK: `mobile/release/app-release.apk` — installable on Android 10 (API 29) or newer.

The server address is configurable in-app (Settings → Server):

- Android emulator on the same machine: `http://10.0.2.2:8080`
- Physical phone on the same Wi-Fi: `http://<laptop-LAN-IP>:8080`

Auth tokens are stored in the Android Keystore via `flutter_secure_storage`.

### Build from source

```bash
cd mobile
flutter pub get
flutter build apk --release
cp build/app/outputs/flutter-apk/app-release.apk release/app-release.apk
```

---

## Offline behaviour

Fixtures, standings, and club profiles are cached in a local Hive database and remain readable with no network. Scoring and roster actions performed offline are written to a persistent queue in the exact `/audit/v1/offline-sync` action format, survive a force-close, and are replayed automatically when connectivity returns. Each action's outcome (applied / rejected with a plain-language reason) is shown before the queue clears.

---

## Pre-submission checklist

- [ ] `DAY1_SALT=<salt> docker compose up -d --build` works from a clean clone; `/health` is 200 within 2 minutes
- [ ] `POST /audit/v1/reset` twice in a row leaves identical state; all seed ids and 5 demo accounts exist
- [ ] Signature matches Appendix A test vector 1
- [ ] 20 parallel checkouts on stock 1 → one 201, nineteen 409, stock 0, reserved 0
- [ ] `/audit/v1/*` is not rate limited; `/api/v1/ping` is
- [ ] No sport name or event name appears in `src/domain/` (`grep -riE 'football|basketball|cricket|esports|goal|wicket' src/domain/` returns nothing)
- [ ] `COVERAGE.json`, `TRACEABILITY.md`, `README.md`, `.env.example`, `mobile/release/app-release.apk` committed
- [ ] Last commit pushed before 15:05:00 PKT
