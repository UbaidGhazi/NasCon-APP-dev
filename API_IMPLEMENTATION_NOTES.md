# Endpoint Implementation Notes — the traps, per route

The spec is the contract. This file only records the places where a straightforward implementation fails a hidden vector.

---

## Global

- **Validation order is graded:** 400 schema → 404 unknown id → 409 business rule. First failure wins. Write the checks in that literal order; do not let an ORM lookup fire before schema validation.
- **Idempotency keys:** `event_id`, `order_id`, `request_id`, `action_id`. Store a hash of the request body with the stored response. Identical replay → **200** with the stored body. Same id, different body → **409 DUPLICATE_***. First success → **201**. Getting 200-vs-201 wrong fails the vector even when everything else is right.
- **`/audit/v1/*` and `/health` are exempt from rate limiting.** The grader sends 200 req/s. If your rate-limit middleware is global, you fail every area at once.
- **413** on bodies over 1 MB — must be enforced *before* JSON parsing, in middleware.
- Unknown fields are ignored; missing required fields or wrong types are 400.
- Money is integer minor units. `450000` is PKR 4500.00. Never a float.

---

## `GET /health`
200 `{"status":"ok"}` only when the DB is reachable **and** seed data exists. The grader polls every 2 s for up to 120 s. Return 503 before seeding finishes — do not return 200 early.

## `POST /audit/v1/reset`
Must leave **byte-identical** state every time. Truncate in FK-safe order, then reseed. Exact ids from §5.5: tenants `tenant-alpha` / `tenant-beta`; product `prod-jersey-001`; variants `var-jersey-001-M` (default stock 1) and `var-jersey-001-L` (default 5), both `price_minor` 450000; discount `WELCOME10` = 10%; leagues `league-alpha-1`, `league-alpha-2`, `league-beta-1`; clubs `club-alpha-1`, `club-alpha-2`, `club-beta-1`; players `player-alpha-1`, `player-alpha-2`, `player-beta-1`; the four seeded sports stored as ordinary rows using the §5.6 schema; the five demo users.

The `seed` value persists — it is the default `lots_seed` for leagues registered afterwards.

## `POST /audit/v1/sports`
The new sport is usable immediately with no restart. `sport_id` regex `^[a-z0-9_-]{2,40}$`; duplicate → 409 `SPORT_EXISTS`. Echo the stored config back in `config`. `tie_break_order` defaults to the full list, and `draw_lots` is applied last even when omitted. Validate per `scoring_model`: event needs `{points}`, innings needs `{runs, legal_ball, wicket}`, round needs `{rounds}`.

## `POST /audit/v1/fixtures`
Stores nothing — pure computation.

- **Round robin:** rounds per leg = `n−1` (even) or `n` (odd); matches per round `⌊n/2⌋`; `byes` is `[]` for even n, one team for odd. Round numbers are **global** across legs. `match_id` = `RR-L{leg}-R{round}-M{index}`. Home/away balance within a leg: `|home − away| ≤ 1`. Withdrawn fixtures are **never removed**, only re-statused.
- **Swiss:** round 1 is **exact** — `m = ⌊n/2⌋`, odd n gives the last seed the bye, pair seed `i` with seed `i+m`, home = lower seed. Rounds ≥ 2 are checked as properties, and criterion (d) means the sum of `|score difference|` over pairs must be **minimal** — greedy pairing fails. Use backtracking or min-weight matching. Bye goes to the lowest-scoring team that has not had one (tie → largest index). Buchholz counts a bye as 0.
- **Single elim:** seed order is recursive — `order(2)=[1,2]`, `order(2k)` = for each `s` in `order(k)`: `[s, 2k+1−s]`. So `order(8)=[1,8,4,5,2,7,3,6]`. Missing seeds → `bye:true`, `away:null`, winner propagated **immediately**. Advancement: winner of `R{r}M{i}` → `R{r+1}M{ceil(i/2)}`, slot `home` if `i` odd else `away`.
- **Double elim:** WR1 identical to single elim. `WR{r}M{i}` round r has `B/2^r` matches. Losers rounds `1..2(k−1)`; rounds `2j−1` and `2j` each have `B/2^(j+1)`; total losers matches `B−2`. `GF2.required` is `null` until GF1 has a result, then `true` only if `bracket_reset` and the GF1 winner is `GF1.away`.

## `POST /audit/v1/events`
- `match_init` for an existing stream → 409 `MATCH_EXISTS`; any other type for a missing stream → 404 `MATCH_NOT_FOUND`.
- `sequence` counts **every** event including compensations. `match_version` = log length after the append.
- Innings limit: legal balls ≥ `innings_per_team × overs_per_innings × balls_per_over`, or wickets ≥ `innings_per_team × wickets_per_innings` → 409 `INNINGS_COMPLETE`. Round limit: `≥ (best_of+1)/2` rounds won → 409 `SERIES_ALREADY_DECIDED`. **Compensated events do not count toward these limits.**
- `match_end` with a level score, `draw_allowed` false, and no active `tiebreak_winner` → 409 `TIE_NOT_ALLOWED`.
- `compensation` targets a `score`, `discipline`, or `tiebreak_winner` event of the **same** match. Already compensated / wrong type / other match → 409 `INVALID_COMPENSATION`. Unknown → 404 `EVENT_NOT_FOUND`.
- Signature uses `id = event_id` and the canonical JSON of the **request payload**.

## `GET /audit/v1/score/{match_id}`
Rebuilt from the log on every call. `outcome` is `pending` until completed, then `home_win` / `away_win` / `draw` / `undecided`. `undecided` is the case where the tie-break event was itself compensated — easy to miss. `overs` is a **string**, `"{balls div bpo}.{balls mod bpo}"`. `events[]` includes compensated events and the compensations, in sequence order, with `compensated` / `compensated_by`.

## `GET /audit/v1/standings/{league_id}`
Only `completed` matches with `outcome != undecided` count as played; everything else is "remaining".

- `h2h` must be present for **every ordered pair**, zeros when they never met.
- `resolved_by` names the criterion that separated this team from the next team it was tied with on points, else `null`.
- Innings `diff` is net run rate rounded to 3 decimals; an innings ending on wickets counts as the **full** `overs_per_innings`.
- Qualification uses **points only**, ignoring tie-breaks. `max(T) = points(T) + W × remaining(T)`. Clinched is checked first.

## `POST /audit/v1/roster/transfer`
The eight checks run in the spec's exact order and the **first** failure is returned. Order: schema → existence → tenant → current squad → window → on-loan → squad full → position minimum. A test will deliberately construct a request that violates two rules at once to see which code you return.

Loan auto-return is driven by the `as_of` parameter on the history call, writes a `loan_return` audit entry exactly once, and never duplicates on repeat calls. In-progress match → still accepted, `state: "deferred_until_match_end"` with `blocking_match_id`.

## `POST /audit/v1/checkout`
Order: validate (400) → variants exist (404) → discount (400) → **atomic reservation** (409) → gateway (402) → commit.

`discount_minor = floor(subtotal_minor * 10 / 100)`. Tokens: `tok_success`, `tok_declined` (402 `PAYMENT_DECLINED`), `tok_capture_fail` (402 `PAYMENT_CAPTURE_FAILED`). Released stock must be purchasable again.

Receipt: `signature` over `receipt.payload` **exactly as returned**; `pdf_base64` decodes to a file starting with `%PDF` whose extracted text contains the `order_id` and the total as `PKR 4500.00` — major units, two decimals, **no thousands separator**. Generate it server-side.

After the 20-request burst: one 201, nineteen 409, `stock` 0, `reserved` 0, and the whole burst finishes inside 10 s.

## `POST /audit/v1/rbac-matrix` and the probes
Tokens valid ≥ 1 hour. Reject `alg: none`, tampered signatures, and expired tokens with 401 `UNAUTHENTICATED` — pass `algorithms=["HS256"]` explicitly to the JWT library.

Probes authorize only; they do not mutate and do not validate the body. Allowed → 200 `{"authorized":true}`. Denied → **exactly 403** `FORBIDDEN`. **Cross-tenant by a non-super-admin is 403, never 404** — 404 is only for ids that do not exist at all. Authorization is evaluated before anything else about the request.

Encode §5.13's matrix as a data table, not as nested ifs. P6 is readable by every role inside `tenant-alpha` but 403 across tenants. P5 allows the Club Manager over their own club's players and the Player over themselves only.

## `GET /api/v1/ping`
100 requests per rolling 10 s per client IP. Under the 150-in-5-s probe: the first is 200, at least 40 return 429 `RATE_LIMITED` with a `Retry-After` header, and 11 s later a request succeeds again. A fixed-window counter in Redis satisfies this.

## `POST /audit/v1/offline-sync`
Always HTTP 200 unless the envelope itself is malformed. Sort by `queued_at` ascending (ties keep array order), process sequentially against the state the previous action left, return results in **request** order with `processed_order` reflecting execution order.

| Situation | status | resolution | error_code |
|---|---|---|---|
| Allowed, `base_version == current` | `applied` | `appended` | null |
| Allowed, `base_version < current` | `applied` | `rebased_append` | null |
| `(device_id, action_id)` seen, or same `event_id` with identical payload | `duplicate` | `skipped_duplicate` | null |
| Any §5.9 / §5.11 rule rejects it | `rejected` | `server_wins` | that rule's code |
| `base_version > current` | `rejected` | `server_wins` | `INVALID_BASE_VERSION` |
| Unknown id referenced | `rejected` | `server_wins` | matching `*_NOT_FOUND` |

`signature` is present only for applied `score_event` actions, otherwise null. Re-sending the identical request must return `duplicate` for every action and change nothing.

---

## Security probes to verify before the freeze

```bash
# no token
curl -i localhost:8080/audit/v1/rbac/platform/config                  # 401

# injection in an id
curl -i -X POST localhost:8080/audit/v1/sports -H 'Content-Type: application/json' \
  -d '{"sport_id":"x'\''; DROP TABLE sports;--","name":"x","scoring_model":"event","periods":{"count":1,"duration_minutes":1},"scoring_events":{"a":{"points":1}},"draw_allowed":true,"overtime":{"policy":"none"},"roster":{"min_squad_size":1,"max_squad_size":2,"required_positions":{}}}'
# → 400 VALIDATION_ERROR, never 5xx

# oversized body
head -c 2000000 /dev/zero | tr '\0' 'a' > /tmp/big.txt
curl -i -X POST localhost:8080/audit/v1/reset -H 'Content-Type: application/json' --data-binary @/tmp/big.txt   # 413
```

A 5xx anywhere in these probes is a failed vector. Catch every unhandled exception in one handler and return a structured 500 only as a last resort — but there should be none.
