'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');

describe('Roster Management (§5.11)', () => {
  const leagues = new Map();
  const squads = new Map();
  const players = new Map();
  const registrations = [];
  const rosterAudit = [];
  const matchesInProgress = [];
  const rosterRequests = new Map();

  beforeAll(() => {
    process.env.DAY1_SALT = process.env.DAY1_SALT || 'test-salt';

    const mockQuery = async (sql, params = []) => {
      // DELETE resets
      if (sql.includes('DELETE FROM matches_in_progress')) {
        matchesInProgress.length = 0;
        return { rowCount: 1 };
      }
      if (sql.includes('DELETE FROM roster_audit')) {
        rosterAudit.length = 0;
        return { rowCount: 1 };
      }
      if (sql.includes('DELETE FROM registrations')) {
        registrations.length = 0;
        return { rowCount: 1 };
      }
      if (sql.includes('DELETE FROM squads')) {
        squads.clear();
        return { rowCount: 1 };
      }

      // sports
      if (sql.includes('FROM sports WHERE sport_id = $1')) {
        return { rows: [{ roster: { max_squad_size: 25, required_positions: { gk: 1 } } }] };
      }

      // leagues
      if (sql.includes('INSERT INTO leagues')) {
        leagues.set(params[0], {
          league_id: params[0],
          tenant_id: params[1],
          sport_id: params[2],
          transfer_window: JSON.parse(params[3]),
          max_squad_size: params[4],
          required_positions: JSON.parse(params[5]),
        });
        return { rowCount: 1 };
      }
      if (sql.includes('FROM leagues WHERE league_id = $1')) {
        const l = leagues.get(params[0]);
        return { rows: l ? [l] : [] };
      }

      // squads
      if (sql.includes('INSERT INTO squads')) {
        squads.set(params[0], {
          squad_id: params[0],
          club_id: params[1],
          tenant_id: params[2],
          league_id: params[3],
          name: params[4],
        });
        return { rowCount: 1 };
      }
      if (sql.includes('FROM squads WHERE squad_id = $1')) {
        const sq = squads.get(params[0]);
        return { rows: sq ? [sq] : [] };
      }

      // players
      if (sql.includes('INSERT INTO players')) {
        players.set(params[0], {
          player_id: params[0],
          name: params[1],
          position: params[2],
          club_id: params[3],
        });
        return { rowCount: 1 };
      }
      if (sql.includes('FROM players WHERE player_id = $1')) {
        const p = players.get(params[0]);
        return { rows: p ? [p] : [] };
      }

      // registrations
      if (sql.includes('INSERT INTO registrations')) {
        const id = registrations.length + 1;
        const newReg = {
          id,
          player_id: params[0],
          league_id: params[1],
          squad_id: params[2],
          parent_squad_id: params[3] || null,
          registration_type: params[4] || params[3], // transfer or loan
          start_date: params[4] ? params[4] : new Date().toISOString(),
          loan_end_date: sql.includes('loan_end_date') ? params[5] : null,
          role: 'substitute',
          state: sql.includes('deferred') ? 'deferred_until_match_end' : 'active',
          blocking_match_id: null,
          active: true,
        };
        registrations.push(newReg);
        return { rows: [newReg], rowCount: 1 };
      }
      if (sql.includes('FROM registrations WHERE player_id = $1 AND league_id = $2 AND active = TRUE')) {
        const reg = registrations.find(
          (r) => r.player_id === params[0] && r.league_id === params[1] && r.active
        );
        return { rows: reg ? [reg] : [] };
      }
      if (sql.includes("registration_type = 'loan'")) {
        const list = registrations.filter(
          (r) => r.player_id === params[0] && r.registration_type === 'loan' && r.active
        );
        return { rows: list };
      }
      if (sql.includes('FROM registrations WHERE player_id = $1 AND active = TRUE')) {
        const list = registrations.filter((r) => r.player_id === params[0] && r.active);
        return { rows: list };
      }
      if (sql.includes('SELECT count(*) FROM registrations WHERE league_id = $1 AND squad_id = $2 AND active = TRUE')) {
        const count = registrations.filter(
          (r) => r.league_id === params[0] && r.squad_id === params[1] && r.active
        ).length;
        return { rows: [{ count }] };
      }
      if (sql.includes('JOIN players p ON r.player_id = p.player_id')) {
        const count = registrations.filter((r) => {
          if (r.league_id !== params[0] || r.squad_id !== params[1] || !r.active) return false;
          const p = players.get(r.player_id);
          return p && p.position === params[2];
        }).length;
        return { rows: [{ count }] };
      }
      if (sql.includes('UPDATE registrations SET active = FALSE WHERE id = $1')) {
        const r = registrations.find((x) => x.id === params[0]);
        if (r) r.active = false;
        return { rowCount: 1 };
      }
      if (sql.includes('UPDATE registrations SET')) {
        const r = registrations.find((x) => x.id === params[0]);
        if (r) {
          r.squad_id = r.parent_squad_id;
          r.parent_squad_id = null;
          r.registration_type = 'transfer';
          r.loan_end_date = null;
          r.role = 'substitute';
        }
        return { rowCount: 1 };
      }

      // matches_in_progress
      if (sql.includes('INSERT INTO matches_in_progress')) {
        matchesInProgress.push({
          league_id: params[0],
          match_id: params[1],
          home_squad_id: params[2],
          away_squad_id: params[3],
        });
        return { rowCount: 1 };
      }
      if (sql.includes('FROM matches_in_progress WHERE league_id = $1')) {
        const list = matchesInProgress.filter(
          (m) =>
            m.league_id === params[0] &&
            (m.home_squad_id === params[1] || m.away_squad_id === params[1])
        );
        return { rows: list };
      }

      // roster_audit
      if (sql.includes('INSERT INTO roster_audit')) {
        const entry = {
          audit_id: params[0],
          seq: rosterAudit.length + 1,
          action: params[1],
          player_id: params[2],
          league_id: params[3],
          from_squad_id: params[4],
          to_squad_id: params[5],
          effective_date: params[6],
          state: params[7],
          who: params[8],
          when: params[9],
          why: params[10],
        };
        rosterAudit.push(entry);
        return { rowCount: 1 };
      }
      if (sql.includes("WHERE player_id = $1 AND league_id = $2 AND action = 'loan_return'")) {
        const found = rosterAudit.filter(
          (a) =>
            a.player_id === params[0] &&
            a.league_id === params[1] &&
            a.action === 'loan_return' &&
            a.from_squad_id === params[2]
        );
        return { rows: found };
      }
      if (sql.includes('FROM roster_audit WHERE player_id = $1') || (sql.includes('FROM roster_audit') && sql.includes('ORDER BY seq'))) {
        const list = rosterAudit.filter((a) => a.player_id === params[0]);
        return { rows: list };
      }

      // roster_requests
      if (sql.includes('FROM roster_requests WHERE request_id = $1')) {
        const r = rosterRequests.get(params[0]);
        return { rows: r ? [r] : [] };
      }
      if (sql.includes('INSERT INTO roster_requests')) {
        rosterRequests.set(params[0], {
          request_id: params[0],
          body_hash: params[1],
          response: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2],
        });
        return { rowCount: 1 };
      }

      return { rows: [] };
    };

    jest.spyOn(config, 'q').mockImplementation(mockQuery);
    jest.spyOn(config, 'withTx').mockImplementation(async (fn) => {
      const client = { query: mockQuery, release: () => {} };
      return fn(client);
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('POST /audit/v1/roster/setup sets up league, squads, players, and match in progress', async () => {
    const res = await request(app)
      .post('/audit/v1/roster/setup')
      .send({
        league: {
          league_id: 'lg-roster',
          tenant_id: 'tenant-alpha',
          sport_id: 'football',
          transfer_window: { open: '2026-06-01', close: '2026-08-31' },
          max_squad_size: 2,
          required_positions: { gk: 1 },
        },
        squads: [
          { squad_id: 'sq-1', club_id: 'cl-1', tenant_id: 'tenant-alpha', name: 'Squad 1' },
          { squad_id: 'sq-2', club_id: 'cl-2', tenant_id: 'tenant-alpha', name: 'Squad 2' },
          { squad_id: 'sq-foreign', club_id: 'cl-3', tenant_id: 'tenant-beta', name: 'Foreign' },
        ],
        players: [
          { player_id: 'pl-gk', name: 'Goalie', position: 'gk', squad_id: 'sq-1', role: 'captain' },
          { player_id: 'pl-df', name: 'Defender', position: 'df', squad_id: 'sq-1', role: 'starter' },
          { player_id: 'pl-sq2', name: 'Player 2', position: 'mf', squad_id: 'sq-2', role: 'starter' },
        ],
        matches_in_progress: [
          { match_id: 'match-live', home_squad_id: 'sq-1', away_squad_id: 'sq-2' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('configured');
    expect(res.body.squad_counts['sq-1']).toBe(2);
  });

  test('Check 1: Schema / dates failure returns 400 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-1',
      league_id: 'lg-roster',
      player_id: 'pl-df',
      type: 'loan',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-2',
      effective_date: '2026-07-15',
      loan_end_date: '2026-07-10', // Invalid: loan_end_date <= effective_date
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('Check 2: Unknown entity returns 404', async () => {
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-2',
      league_id: 'lg-roster',
      player_id: 'pl-nonexistent',
      type: 'transfer',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-2',
      effective_date: '2026-07-15',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PLAYER_NOT_FOUND');
  });

  test('Check 3: Cross tenant transfer returns 409 CROSS_TENANT_TRANSFER', async () => {
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-3',
      league_id: 'lg-roster',
      player_id: 'pl-df',
      type: 'transfer',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-foreign',
      effective_date: '2026-07-15',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CROSS_TENANT_TRANSFER');
  });

  test('Check 4: Wrong from_squad returns 409 NOT_IN_SQUAD', async () => {
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-4',
      league_id: 'lg-roster',
      player_id: 'pl-df',
      type: 'transfer',
      from_squad_id: 'sq-2', // pl-df is actually in sq-1
      to_squad_id: 'sq-1',
      effective_date: '2026-07-15',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_IN_SQUAD');
  });

  test('Check 5: Window closed returns 409 TRANSFER_WINDOW_CLOSED', async () => {
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-5',
      league_id: 'lg-roster',
      player_id: 'pl-df',
      type: 'transfer',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-2',
      effective_date: '2026-09-05', // Window closed on 2026-08-31
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSFER_WINDOW_CLOSED');
  });

  test('Precedence check: request violating check 5 (window) and check 7 (squad full) returns check 5 code', async () => {
    // sq-2 has 1 player, max_squad_size is 2. Let's add 1 player so sq-2 has 2 players (full).
    registrations.push({
      id: 99,
      player_id: 'dummy',
      league_id: 'lg-roster',
      squad_id: 'sq-2',
      registration_type: 'initial',
      active: true,
    });

    // Now moving to sq-2 violates squad full (check 7).
    // And effective_date 2026-10-01 violates transfer window (check 5).
    // Check 5 must be returned!
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-precedence',
      league_id: 'lg-roster',
      player_id: 'pl-df',
      type: 'transfer',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-2',
      effective_date: '2026-10-01',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSFER_WINDOW_CLOSED');

    // Clean up dummy
    const idx = registrations.findIndex((r) => r.id === 99);
    if (idx !== -1) registrations.splice(idx, 1);
  });

  test('Check 8: Position minimum violation returns 409 MIN_POSITION_VIOLATION', async () => {
    // pl-gk is the only gk in sq-1, required gk = 1
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-pos-viol',
      league_id: 'lg-roster',
      player_id: 'pl-gk',
      type: 'transfer',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-2',
      effective_date: '2026-07-15',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MIN_POSITION_VIOLATION');
  });

  test('Successful transfer deferred due to in-progress match', async () => {
    // pl-df can move, but sq-1 has a match_in_progress -> deferred
    const res = await request(app).post('/audit/v1/roster/transfer').send({
      request_id: 'req-deferred',
      league_id: 'lg-roster',
      player_id: 'pl-df',
      type: 'transfer',
      from_squad_id: 'sq-1',
      to_squad_id: 'sq-2',
      effective_date: '2026-07-15',
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('deferred_until_match_end');
    expect(res.body.blocking_match_id).toBe('match-live');
  });

  test('Loan and automatic return verified once across two history calls with same as_of', async () => {
    // Setup player on loan
    registrations.push({
      id: 50,
      player_id: 'pl-loaned',
      league_id: 'lg-roster',
      squad_id: 'sq-2',
      parent_squad_id: 'sq-1',
      registration_type: 'loan',
      loan_end_date: '2026-07-31',
      active: true,
    });
    players.set('pl-loaned', { player_id: 'pl-loaned', name: 'Loaned Guy', position: 'mf' });

    // Call history as_of 2026-08-01 (loan expired)
    const res1 = await request(app).get('/audit/v1/roster/history/pl-loaned?as_of=2026-08-01');
    if (res1.body.history.length === 0) console.log('HISTORY RES:', res1.body);
    expect(res1.status).toBe(200);
    const loanReturns1 = res1.body.history.filter((h) => h.action === 'loan_return');
    expect(loanReturns1.length).toBe(1);

    // Repeated call with same as_of must not duplicate the loan_return entry
    const res2 = await request(app).get('/audit/v1/roster/history/pl-loaned?as_of=2026-08-01');
    expect(res2.status).toBe(200);
    const loanReturns2 = res2.body.history.filter((h) => h.action === 'loan_return');
    expect(loanReturns2.length).toBe(1);
  });
});
