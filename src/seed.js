'use strict';
/**
 * §5.5 — schema creation and the exact baseline data /audit/v1/reset must leave.
 *
 * /reset must be repeatable and leave IDENTICAL state every time. The grader
 * calls it before every test group and diffs the result, so every id below is
 * literal and must not drift.
 *
 * The four seeded sports are ordinary rows using the §5.6 schema. They are the
 * ONLY place sport names appear — no file under src/domain/ may mention them.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, withTx } = require('./config');

const FULL_TIE_BREAK = ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'];

// ---------------------------------------------------------------- seeded sports
// Straight from the §5.5 table. Data, not logic.
const SEED_SPORTS = [
  {
    sport_id: 'football',
    name: 'Football',
    scoring_model: 'event',
    periods: { count: 2, duration_minutes: 45 },
    scoring_events: { goal: { points: 1 } },
    draw_allowed: true,
    overtime: { policy: 'none' },
    tie_break_order: FULL_TIE_BREAK,
    roster: { min_squad_size: 11, max_squad_size: 25, required_positions: { gk: 1 } },
  },
  {
    sport_id: 'basketball',
    name: 'Basketball',
    scoring_model: 'event',
    periods: { count: 4, duration_minutes: 12 },
    scoring_events: {
      free_throw: { points: 1 },
      two_pointer: { points: 2 },
      three_pointer: { points: 3 },
    },
    draw_allowed: false,
    overtime: { policy: 'extra_time', duration_minutes: 5 },
    tie_break_order: FULL_TIE_BREAK,
    roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
  },
  {
    sport_id: 'cricket',
    name: 'Cricket',
    scoring_model: 'innings',
    periods: { innings_per_team: 1, overs_per_innings: 20, balls_per_over: 6, wickets_per_innings: 10 },
    scoring_events: {
      dot_ball: { runs: 0, legal_ball: true, wicket: false },
      single: { runs: 1, legal_ball: true, wicket: false },
      two: { runs: 2, legal_ball: true, wicket: false },
      four: { runs: 4, legal_ball: true, wicket: false },
      six: { runs: 6, legal_ball: true, wicket: false },
      wide: { runs: 1, legal_ball: false, wicket: false },
      no_ball: { runs: 1, legal_ball: false, wicket: false },
      wicket: { runs: 0, legal_ball: true, wicket: true },
    },
    draw_allowed: true,
    overtime: { policy: 'super_over' },
    tie_break_order: FULL_TIE_BREAK,
    roster: { min_squad_size: 11, max_squad_size: 18, required_positions: { wicketkeeper: 1 } },
  },
  {
    sport_id: 'esports',
    name: 'Esports',
    scoring_model: 'round',
    periods: { best_of: 3 },
    scoring_events: { round_win: { rounds: 1 } },
    draw_allowed: false,
    overtime: { policy: 'none' },
    tie_break_order: FULL_TIE_BREAK,
    roster: { min_squad_size: 5, max_squad_size: 8, required_positions: {} },
  },
];

// ------------------------------------------------------------- demo accounts §8.3
const DEMO_USERS = [
  { user_id: 'user-admin',     email: 'admin@nascon.test',     role: 'super_admin',      tenant_id: null,           league_id: null,             club_id: null,            player_id: null },
  { user_id: 'user-organizer', email: 'organizer@nascon.test', role: 'league_organizer', tenant_id: 'tenant-alpha', league_id: 'league-alpha-1', club_id: null,            player_id: null },
  { user_id: 'user-manager',   email: 'manager@nascon.test',   role: 'club_manager',     tenant_id: 'tenant-alpha', league_id: null,             club_id: 'club-alpha-1',  player_id: null },
  { user_id: 'user-player',    email: 'player@nascon.test',    role: 'player',           tenant_id: 'tenant-alpha', league_id: null,             club_id: 'club-alpha-1',  player_id: 'player-alpha-1' },
  { user_id: 'user-viewer',    email: 'viewer@nascon.test',    role: 'viewer',           tenant_id: 'tenant-alpha', league_id: null,             club_id: null,            player_id: null },
];
const DEMO_PASSWORD = 'Nascon@26';

// Hashed once per process — bcrypt on every reset would blow the 10 s budget.
let CACHED_HASH = null;
function demoHash() {
  if (!CACHED_HASH) CACHED_HASH = bcrypt.hashSync(DEMO_PASSWORD, 8);
  return CACHED_HASH;
}

const DEFAULT_STOCK = { 'var-jersey-001-M': 1, 'var-jersey-001-L': 5 };

/** Creates every table. Safe to run on every boot. */
async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

/** Truncate everything, then write the baseline. One transaction, so /reset is atomic. */
async function resetAndSeed({ seed = 42, stock = {} } = {}) {
  const finalStock = { ...DEFAULT_STOCK, ...stock };

  await withTx(async (c) => {
    await c.query(`
      TRUNCATE TABLE
        match_events, matches, league_teams, leagues,
        registrations, roster_audit, roster_requests, matches_in_progress,
        squads, players, clubs,
        orders, inventory, variants, products, discount_codes,
        users, offline_actions, sports, tenants, app_state
      RESTART IDENTITY CASCADE
    `);

    await c.query(`INSERT INTO app_state (k, v) VALUES ('seed', $1)`, [JSON.stringify(seed)]);

    // Tenants
    await c.query(
      `INSERT INTO tenants (tenant_id, name, logo_url, primary_color) VALUES
         ('tenant-alpha','Alpha Sports','/logos/alpha.png','#1d4ed8'),
         ('tenant-beta','Beta Athletics','/logos/beta.png','#b91c1c')`
    );

    // Sports — stored exactly like a sport created through POST /audit/v1/sports
    for (const s of SEED_SPORTS) {
      await c.query(
        `INSERT INTO sports (sport_id, name, scoring_model, periods, scoring_events,
                             draw_allowed, overtime, tie_break_order, roster)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.sport_id, s.name, s.scoring_model, JSON.stringify(s.periods),
         JSON.stringify(s.scoring_events), s.draw_allowed, JSON.stringify(s.overtime),
         JSON.stringify(s.tie_break_order), JSON.stringify(s.roster)]
      );
    }

    // RBAC scenario (§5.5) — the ids /audit/v1/rbac-matrix hands back in `context`
    await c.query(
      `INSERT INTO leagues (league_id, tenant_id, sport_id, lots_seed) VALUES
         ('league-alpha-1','tenant-alpha','football',$1),
         ('league-alpha-2','tenant-alpha','football',$1),
         ('league-beta-1','tenant-beta','football',$1)`,
      [seed]
    );
    await c.query(
      `INSERT INTO clubs (club_id, tenant_id, name, venue_lat, venue_lng) VALUES
         ('club-alpha-1','tenant-alpha','Alpha United',33.7715,72.7517),
         ('club-alpha-2','tenant-alpha','Alpha Rovers',33.6844,73.0479),
         ('club-beta-1','tenant-beta','Beta City',31.5204,74.3587)`
    );
    await c.query(
      `INSERT INTO players (player_id, name, position, club_id) VALUES
         ('player-alpha-1','Alpha One','gk','club-alpha-1'),
         ('player-alpha-2','Alpha Two','df','club-alpha-2'),
         ('player-beta-1','Beta One','mf','club-beta-1')`
    );

    // Store (§5.5): product, two variants at 450000 paisa, WELCOME10 = 10%
    await c.query(
      `INSERT INTO products (product_id, tenant_id, name)
       VALUES ('prod-jersey-001','tenant-alpha','Alpha Home Jersey')`
    );
    await c.query(
      `INSERT INTO variants (variant_id, product_id, price_minor, currency) VALUES
         ('var-jersey-001-M','prod-jersey-001',450000,'PKR'),
         ('var-jersey-001-L','prod-jersey-001',450000,'PKR')`
    );
    for (const [variantId, units] of Object.entries(finalStock)) {
      await c.query(
        `INSERT INTO inventory (variant_id, stock, reserved) VALUES ($1,$2,0)
         ON CONFLICT (variant_id) DO UPDATE SET stock = EXCLUDED.stock, reserved = 0`,
        [variantId, units]
      );
    }
    await c.query(`INSERT INTO discount_codes (code, percent) VALUES ('WELCOME10',10)`);

    // Demo accounts (§8.3) — must exist after every startup and every reset
    const hash = demoHash();
    for (const u of DEMO_USERS) {
      await c.query(
        `INSERT INTO users (user_id, email, password_hash, role, tenant_id, league_id, club_id, player_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.user_id, u.email, hash, u.role, u.tenant_id, u.league_id, u.club_id, u.player_id]
      );
    }
  });

  return {
    status: 'reset_complete',
    seed,
    sports: SEED_SPORTS.map((s) => s.sport_id),
    tenants: ['tenant-alpha', 'tenant-beta'],
    stock: finalStock,
  };
}

/** /health is 200 only once this is true. */
async function isSeeded() {
  try {
    const r = await pool.query(
      `SELECT (SELECT count(*) FROM tenants) AS t,
              (SELECT count(*) FROM sports)  AS s,
              (SELECT count(*) FROM users)   AS u`
    );
    const row = r.rows[0];
    return Number(row.t) >= 2 && Number(row.s) >= 4 && Number(row.u) >= 5;
  } catch (_) {
    return false;
  }
}

module.exports = { ensureSchema, resetAndSeed, isSeeded, SEED_SPORTS, DEMO_USERS, DEFAULT_STOCK, FULL_TIE_BREAK };
