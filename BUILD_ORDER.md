# NaSCon '26 — Phase I Build Order (Quantum Coders)

**Lock: 15:00 PKT. Final push: 15:05:00 PKT. Desk check: 15:15 PKT.**

---

## 0. The scoring reality (read this first)

50 points split as:

| Component | Points | Who grades it |
|---|---|---|
| Backend platform (6 areas) | 36 | Python scripts |
| Offline mobile persistence + sync | 4 | Script + desk check |
| Mobile UI / HCI | 10 | Human judges, 10-min slot |

The 36 backend points are split across **six areas of roughly 6 points each**:

1. Fixture algorithms (round-robin + Swiss + single elim + double elim) — **all four share ~6 points**
2. Event-sourced scoring engine — ~6
3. Standings engine — ~6
4. Store concurrency + PDF receipt — ~6
5. Roster / transfer / loan rules — ~6
6. RBAC 5-role matrix + API security — ~6

**The trap:** fixtures is four separate hard algorithms (circle method, Swiss backtracking/matching, recursive seed order, double-elim graph routing) competing for the *same* ~6 points that RBAC earns with a permission table. Teams instinctively start with fixtures because it is section 5.7. That is how you end up at 12/50.

**Point-per-minute ranking — build in this order:**

| Rank | Area | Pts | Est. | Rate |
|---|---|---|---|---|
| 1 | Docker + `/health` + `/reset` | enables all 36, avoids −10 | 25 min | infinite |
| 2 | RBAC + security probes | ~6 | 40 min | highest |
| 3 | Store + concurrency + PDF | ~6 | 45 min | high |
| 4 | Scoring engine (`/events`, `/score`) | ~6 | 55 min | medium |
| 5 | Standings | ~6 | 40 min | medium (depends on 4) |
| 6 | Roster / transfers | ~6 | 40 min | medium |
| 7 | Fixtures — round robin only | partial | 35 min | low |
| 8 | Fixtures — single elim | partial | 30 min | low |
| 9 | Fixtures — Swiss / double elim | partial | 60 min+ | **lowest — likely skip** |

Scoring function per area: `S = 0.9·P·(n/|V|) + 0.1·P·[coverage ≥ 85%]`.
Note the **10% coverage bonus is free** — writing 3 trivial pytest files per area is worth ~0.6 pts each, ~3.6 pts total, for about 25 minutes of work. That is worth more than finishing double elimination.

---

## 1. Team split (non-negotiable)

Mobile is **14 of 50 points (28%)** and has a hard desk check at 15:15. If nobody owns mobile full-time, you lose 14 points no matter how good the backend is.

| Person | Owns | Stops at |
|---|---|---|
| **A** | Docker, `/reset`, signatures, RBAC, security probes | 14:30, then helps test |
| **B** | Store + checkout + PDF, then roster/transfers | 14:30 |
| **C** | Events + score projection, then standings | 14:30 |
| **D** | **Mobile only. Does not touch backend.** | 14:45, install APK |

If you are only 3 people: **drop fixtures entirely** and keep D on mobile. Fixtures is the one area you can afford to zero.

---

## 2. Hour-by-hour

### 11:35 – 11:45 — FIRST PUSH (window 1 closes 11:45)
- `git init`, push the repo skeleton from this pack: `docker-compose.yml`, `.env.example`, `README.md`, `TRACEABILITY.md`, `COVERAGE.json`, `run_tests.sh`, empty `app/` and `mobile/`.
- **Confirm the GitHub URL is registered at the venue desk.** Registration closed at 11:15 — if it is not done, go now.
- Repo must be **public**.

### 11:45 – 12:45 (window 2)
- A: `docker compose up` green, `/health` 200, `/reset` seeding exact baseline ids, signature helper + Appendix A test vector passing.
- B: product/variant tables, `/audit/v1/inventory/{id}`, checkout happy path.
- C: event table, `match_init`/`match_start`/`score`/`match_end`, `/score` projection.
- D: Flutter project builds, login screen, API client, Hive cache set up.
- **Push at ~12:40.**

### 12:45 – 13:45 (window 3)
- A: RBAC matrix endpoint, 7 probe routes, JWT 401 cases, rate limiter on `/api/v1/ping`, 413 body limit.
- B: `SELECT ... FOR UPDATE` reservation, mock gateway tokens, PDF receipt with WeasyPrint.
- C: compensation events, innings/round models, then standings table + tie-break resolver.
- D: Fixtures/Standings/Match detail screens, offline queue in Hive.
- **Push at ~13:40.**

### 13:45 – 14:45 (window 4)
- A: `/audit/v1/sports` mystery sport, then help whoever is behind.
- B: roster setup/transfer/history with the 8 ordered checks.
- C: `/offline-sync` (it reuses scoring + roster code — cheap once those exist).
- D: Store screen + checkout + receipt, sync status indicator, **build the APK by 14:30**.
- Everyone: write the pytest files, fill real numbers into `COVERAGE.json`.
- **Push at ~14:40.**

### 14:45 – 15:05 — FREEZE
- No new features. Run `./run_tests.sh`. Run the pre-submission checklist in `README.md`.
- `docker compose down -v && DAY1_SALT=<salt> docker compose up -d --build` on a **clean** state — this is exactly what the grader does.
- Commit `mobile/release/app-release.apk`. **Final push by 15:00, absolute limit 15:05:00.**

### 15:15 — Desk check
- Backend already running. Phone already has the APK. Do not install during the slot.

---

## 3. Penalties you must actively avoid

| Penalty | Pts | How you avoid it |
|---|---|---|
| Non-reproducible Docker | −10 | Test `up --build` from scratch at 14:45, not at 15:00 |
| Hard-coded sport logic | −8 | **Never write `if sport == "football"` or `if event == "goal"`.** All scoring reads from the sport config row. They scan code for this. |
| Managed BaaS | −10 | No Firebase/Supabase anywhere |
| Missed push window | −2 each (max −8) | Set 4 phone alarms: 11:40, 12:40, 13:40, 14:40 |

`−8` for hard-coded sport logic is larger than the entire fixtures area. Treat the config-driven rule as sacred.

---

## 4. What to deliberately sacrifice

If you are behind at 13:45, cut in this order:
1. Double elimination (`/fixtures` double_elim) — return 400 rather than wrong data
2. Swiss pairing
3. Third-place match, bracket reset
4. MinIO usage (keep the container for compose compliance, store PDFs in Postgres bytea)
5. Realtime WebSocket (not script-graded in Phase I; judges only need the match screen to update — poll every 3 s)

Never cut: `/reset` determinism, signatures, RBAC, checkout concurrency, the APK.
