-- Full schema. Created once at startup (idempotent), then /audit/v1/reset
-- truncates and reseeds. Nothing here branches on a sport name: sports are rows.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  logo_url      TEXT,
  primary_color TEXT
);

-- Sport rules live entirely as data (FR-1.1, and the -8 hard-coding penalty).
CREATE TABLE IF NOT EXISTS sports (
  sport_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  scoring_model   TEXT NOT NULL CHECK (scoring_model IN ('event','innings','round')),
  periods         JSONB NOT NULL,
  scoring_events  JSONB NOT NULL,
  draw_allowed    BOOLEAN NOT NULL,
  overtime        JSONB NOT NULL,
  tie_break_order JSONB NOT NULL,
  roster          JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  league_id           TEXT PRIMARY KEY,
  tenant_id           TEXT REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  sport_id            TEXT NOT NULL,
  points              JSONB NOT NULL DEFAULT '{"win":3,"draw":1,"loss":0}',
  tie_break_order     JSONB,
  qualification_spots INT,
  lots_seed           INT NOT NULL DEFAULT 42,
  transfer_window     JSONB,
  max_squad_size      INT,
  required_positions  JSONB
);

CREATE TABLE IF NOT EXISTS league_teams (
  league_id TEXT NOT NULL REFERENCES leagues(league_id) ON DELETE CASCADE,
  team_id   TEXT NOT NULL,
  seed_idx  INT  NOT NULL,
  PRIMARY KEY (league_id, team_id)
);

CREATE TABLE IF NOT EXISTS matches (
  match_id      TEXT PRIMARY KEY,
  league_id     TEXT,
  sport_id      TEXT NOT NULL,
  home_team_id  TEXT NOT NULL,
  away_team_id  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  -- status is DERIVED from the event log on read. Never stored as truth.
);

-- APPEND ONLY. The only column ever updated is `compensated` / `compensated_by`.
CREATE TABLE IF NOT EXISTS match_events (
  id             BIGSERIAL PRIMARY KEY,
  match_id       TEXT NOT NULL,
  event_id       TEXT NOT NULL UNIQUE,
  seq            INT  NOT NULL,
  type           TEXT NOT NULL,
  payload        JSONB NOT NULL,
  signature      TEXT NOT NULL,
  compensated    BOOLEAN NOT NULL DEFAULT FALSE,
  compensated_by TEXT,
  body_hash      TEXT NOT NULL,          -- for idempotent replay detection
  response       JSONB NOT NULL,         -- stored 201 body, returned on replay
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_match ON match_events(match_id, seq);

CREATE TABLE IF NOT EXISTS clubs (
  club_id   TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  venue_lat DOUBLE PRECISION,
  venue_lng DOUBLE PRECISION,
  socials   JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS squads (
  squad_id  TEXT PRIMARY KEY,
  club_id   TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  league_id TEXT,
  name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  position  TEXT,
  club_id   TEXT
);

CREATE TABLE IF NOT EXISTS registrations (
  id                BIGSERIAL PRIMARY KEY,
  player_id         TEXT NOT NULL,
  league_id         TEXT NOT NULL,
  squad_id          TEXT,
  parent_squad_id   TEXT,
  registration_type TEXT NOT NULL,   -- initial | transfer | loan | release
  start_date        DATE,
  loan_end_date     DATE,
  role              TEXT,            -- captain | vice_captain | starter | substitute
  state             TEXT NOT NULL DEFAULT 'active',
  blocking_match_id TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_reg_player ON registrations(player_id, league_id, active);

-- APPEND ONLY.
CREATE TABLE IF NOT EXISTS roster_audit (
  audit_id       TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  action         TEXT NOT NULL,       -- transfer | loan | release | loan_return
  player_id      TEXT NOT NULL,
  league_id      TEXT NOT NULL,
  from_squad_id  TEXT,
  to_squad_id    TEXT,
  effective_date DATE,
  state          TEXT,
  who            TEXT,
  when_ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  why            TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_player ON roster_audit(player_id, seq);

CREATE TABLE IF NOT EXISTS roster_requests (
  request_id TEXT PRIMARY KEY,
  body_hash  TEXT NOT NULL,
  response   JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS matches_in_progress (
  league_id     TEXT NOT NULL,
  match_id      TEXT NOT NULL,
  home_squad_id TEXT NOT NULL,
  away_squad_id TEXT NOT NULL,
  PRIMARY KEY (league_id, match_id)
);

CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS variants (
  variant_id  TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  price_minor BIGINT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'PKR'
);

-- The row that gets SELECT ... FOR UPDATE'd by every checkout (NFR-3).
CREATE TABLE IF NOT EXISTS inventory (
  variant_id TEXT PRIMARY KEY,
  stock      INT NOT NULL CHECK (stock >= 0),
  reserved   INT NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);

CREATE TABLE IF NOT EXISTS discount_codes (
  code    TEXT PRIMARY KEY,
  percent INT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_id    TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status      TEXT NOT NULL,  -- pending|paid|packed|shipped|delivered|cancelled|refunded
  body_hash   TEXT NOT NULL,
  response    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,  -- super_admin|league_organizer|club_manager|player|viewer
  tenant_id     TEXT,
  league_id     TEXT,
  club_id       TEXT,
  player_id     TEXT
);

CREATE TABLE IF NOT EXISTS offline_actions (
  device_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  result    JSONB NOT NULL,
  PRIMARY KEY (device_id, action_id)
);

-- Single-row table holding the seed from the last /reset (default lots_seed).
CREATE TABLE IF NOT EXISTS app_state (
  k TEXT PRIMARY KEY,
  v JSONB NOT NULL
);
