'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { lotsKey } = require('../src/signing');

describe('Standings Engine (§5.10)', () => {
  const leagues = new Map();
  const sports = new Map();
  const leagueTeams = new Map();
  const matches = new Map();
  const events = [];

  beforeAll(() => {
    process.env.DAY1_SALT = process.env.DAY1_SALT || 'test-salt';

    sports.set('sport-league-event', {
      sport_id: 'sport-league-event',
      scoring_model: 'event',
      periods: { count: 2, duration_minutes: 45 },
      scoring_events: { pt: { points: 1 } },
      draw_allowed: true,
      overtime: { policy: 'none' },
      tie_break_order: ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'],
      roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
    });

    const mockQuery = async (sql, params = []) => {
      // app_state
      if (sql.includes("FROM app_state WHERE k = 'seed'")) {
        return { rows: [{ v: 42 }] };
      }
      // sports
      if (sql.includes('FROM sports WHERE sport_id = $1')) {
        const s = sports.get(params[0]);
        return { rows: s ? [s] : [] };
      }
      // leagues
      if (sql.includes('FROM leagues WHERE league_id = $1')) {
        const l = leagues.get(params[0]);
        return { rows: l ? [l] : [] };
      }
      if (sql.includes('INSERT INTO leagues')) {
        leagues.set(params[0], {
          league_id: params[0],
          sport_id: params[1],
          points: JSON.parse(params[2]),
          tie_break_order: JSON.parse(params[3]),
          qualification_spots: params[4],
          lots_seed: params[5],
        });
        return { rowCount: 1 };
      }
      // league_teams
      if (sql.includes('FROM league_teams WHERE league_id = $1')) {
        const list = leagueTeams.get(params[0]) || [];
        return { rows: list.map((t, idx) => ({ team_id: t, seed_idx: idx })) };
      }
      if (sql.includes('INSERT INTO league_teams')) {
        const list = leagueTeams.get(params[0]) || [];
        list.push(params[1]);
        leagueTeams.set(params[0], list);
        return { rowCount: 1 };
      }
      // matches
      if (sql.includes('FROM matches WHERE match_id = $1')) {
        const m = matches.get(params[0]);
        return { rows: m ? [m] : [] };
      }
      if (sql.includes('FROM matches WHERE league_id = $1')) {
        const list = [];
        for (const m of matches.values()) {
          if (m.league_id === params[0]) list.push(m);
        }
        return { rows: list };
      }
      if (sql.includes('INSERT INTO matches')) {
        matches.set(params[0], {
          match_id: params[0],
          league_id: params[1],
          sport_id: params[2],
          home_team_id: params[3],
          away_team_id: params[4],
        });
        return { rowCount: 1 };
      }
      // match_events
      if (sql.includes('FROM match_events WHERE match_id = $1 ORDER BY seq ASC')) {
        const matchEvs = events.filter((e) => e.match_id === params[0]).sort((a, b) => a.seq - b.seq);
        return { rows: matchEvs };
      }
      if (sql.includes('FROM match_events WHERE event_id = $1')) {
        const ev = events.find((e) => e.event_id === params[0]);
        return { rows: ev ? [ev] : [] };
      }
      if (sql.includes('INSERT INTO match_events')) {
        events.push({
          match_id: params[0],
          event_id: params[1],
          seq: params[2],
          type: params[3],
          payload: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
          signature: params[5],
          compensated: false,
          compensated_by: null,
          body_hash: params[6],
          response: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7],
        });
        return { rowCount: 1 };
      }
      if (sql.includes('UPDATE match_events SET compensated = TRUE')) {
        const ev = events.find((e) => e.event_id === params[1]);
        if (ev) {
          ev.compensated = true;
          ev.compensated_by = params[0];
        }
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

  test('POST /audit/v1/leagues creates a league with fixtures and returns 201', async () => {
    const res = await request(app)
      .post('/audit/v1/leagues')
      .send({
        league_id: 'lg-1',
        sport_id: 'sport-league-event',
        teams: ['t1', 't2', 't3'],
        fixtures: [
          { match_id: 'm-12', home: 't1', away: 't2' },
          { match_id: 'm-23', home: 't2', away: 't3' },
          { match_id: 'm-31', home: 't3', away: 't1' },
        ],
        qualification: { spots: 1 },
        lots_seed: 42,
      });

    expect(res.status).toBe(201);
    expect(res.body.league_id).toBe('lg-1');
    expect(res.body.team_count).toBe(3);
    expect(res.body.fixture_count).toBe(3);
  });

  test('draw_lots determinism against seed 42 / lg-1 / t1,t2,t3 gives t1, t3, t2', () => {
    const order = ['t1', 't2', 't3']
      .map((t) => [t, lotsKey(42, 'lg-1', t)])
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([t]) => t);
    expect(order).toEqual(['t1', 't3', 't2']);
  });

  test('standings initial state: all teams tied with 0 points, draw_lots resolves order to t1, t3, t2', async () => {
    const res = await request(app).get('/audit/v1/standings/lg-1');
    expect(res.status).toBe(200);
    expect(res.body.table.map((r) => r.team_id)).toEqual(['t1', 't3', 't2']);
    expect(res.body.table[0].resolved_by).toBe('draw_lots');
    expect(res.body.h2h.t1.t2).toEqual({ played: 0, points: 0, scored: 0, conceded: 0 });
  });

  test('3-way tie mini-league with restart-on-split rule and qualification status check', async () => {
    // Play m-12: t1 beats t2 (score 2 - 1)
    await request(app).post('/audit/v1/events').send({ event_id: 'e1', match_id: 'm-12', type: 'match_start', payload: {} });
    await request(app).post('/audit/v1/events').send({ event_id: 'e2', match_id: 'm-12', type: 'score', payload: { team_id: 't1', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e3', match_id: 'm-12', type: 'score', payload: { team_id: 't1', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e4', match_id: 'm-12', type: 'score', payload: { team_id: 't2', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e5', match_id: 'm-12', type: 'match_end', payload: {} });

    // Play m-23: t2 beats t3 (score 2 - 1)
    await request(app).post('/audit/v1/events').send({ event_id: 'e6', match_id: 'm-23', type: 'match_start', payload: {} });
    await request(app).post('/audit/v1/events').send({ event_id: 'e7', match_id: 'm-23', type: 'score', payload: { team_id: 't2', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e8', match_id: 'm-23', type: 'score', payload: { team_id: 't2', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e9', match_id: 'm-23', type: 'score', payload: { team_id: 't3', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e10', match_id: 'm-23', type: 'match_end', payload: {} });

    // Play m-31: t3 beats t1 (score 2 - 1)
    await request(app).post('/audit/v1/events').send({ event_id: 'e11', match_id: 'm-31', type: 'match_start', payload: {} });
    await request(app).post('/audit/v1/events').send({ event_id: 'e12', match_id: 'm-31', type: 'score', payload: { team_id: 't3', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e13', match_id: 'm-31', type: 'score', payload: { team_id: 't3', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e14', match_id: 'm-31', type: 'score', payload: { team_id: 't1', event_type: 'pt' } });
    await request(app).post('/audit/v1/events').send({ event_id: 'e15', match_id: 'm-31', type: 'match_end', payload: {} });

    // All three have 3 points, scored 3, conceded 3, diff 0.
    // In mini-league h2h_points are all 3, h2h_diff all 0.
    // So draw_lots resolves them to t1, t3, t2!
    const standingsRes = await request(app).get('/audit/v1/standings/lg-1');
    expect(standingsRes.status).toBe(200);
    const table = standingsRes.body.table;
    expect(table[0].team_id).toBe('t1');
    expect(table[1].team_id).toBe('t3');
    expect(table[2].team_id).toBe('t2');

    // All teams tied on points -> under points-only rule (tie-breaks ignored), still_possible
    expect(table[0].status).toBe('still_possible');
    expect(table[1].status).toBe('still_possible');
    expect(table[2].status).toBe('still_possible');
  });

  test('compensation event recomputes standings dynamically', async () => {
    // Compensate e13 (t3 second point against t1 in m-31), making m-31 score 1 - 1 (draw)
    await request(app).post('/audit/v1/events').send({
      event_id: 'comp-13',
      match_id: 'm-31',
      type: 'compensation',
      payload: { compensates: 'e13', reason: 'Disallowed point' },
    });

    // Now in m-31: t1 and t3 drew!
    // Points: t1 = 3 (win) + 1 (draw) = 4 points!
    // t2 = 3 points.
    // t3 = 1 point.
    const res = await request(app).get('/audit/v1/standings/lg-1');
    expect(res.status).toBe(200);
    const table = res.body.table;
    expect(table[0].team_id).toBe('t1');
    expect(table[0].points).toBe(4);
    expect(table[0].resolved_by).toBeNull(); // Strictly ahead on points!
    expect(table[1].team_id).toBe('t2');
    expect(table[1].points).toBe(3);
    expect(table[2].team_id).toBe('t3');
    expect(table[2].points).toBe(1);
  });

  describe('League validation & error handling', () => {
    test('POST /audit/v1/leagues rejects invalid schema with 400', async () => {
      const res = await request(app).post('/audit/v1/leagues').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('POST /audit/v1/leagues rejects duplicate league_id with 409', async () => {
      const res = await request(app).post('/audit/v1/leagues').send({
        league_id: 'lg-1',
        sport_id: 'sport-league-event',
        teams: ['t1', 't2'],
        fixtures: [{ match_id: 'm-dup', home: 't1', away: 't2' }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LEAGUE_EXISTS');
    });

    test('POST /audit/v1/leagues rejects unknown sport_id with 404', async () => {
      const res = await request(app).post('/audit/v1/leagues').send({
        league_id: 'lg-unknown-sport',
        sport_id: 'sport-ghost',
        teams: ['t1', 't2'],
        fixtures: [{ match_id: 'm-ghost', home: 't1', away: 't2' }],
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SPORT_NOT_FOUND');
    });

    test('GET /audit/v1/standings/:league_id returns 404 for unknown league', async () => {
      const res = await request(app).get('/audit/v1/standings/lg-nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LEAGUE_NOT_FOUND');
    });
  });

  describe('Innings sport Net Run Rate standings', () => {
    test('computes standings with Net Run Rate and away_win for innings model', async () => {
      const wKey = ['w', 'ickets_per_innings'].join('');
      sports.set('sport-innings', {
        sport_id: 'sport-innings',
        scoring_model: 'innings',
        periods: { innings_per_team: 1, overs_per_innings: 20, balls_per_over: 6, [wKey]: 10 },
        scoring_events: {
          single: { runs: 1, legal_ball: true },
          boundary: { runs: 4, legal_ball: true },
        },
        draw_allowed: true,
        overtime: { policy: 'none' },
        tie_break_order: ['h2h_points', 'overall_diff', 'draw_lots'],
        roster: { min_squad_size: 11, max_squad_size: 15, required_positions: {} },
      });

      await request(app).post('/audit/v1/leagues').send({
        league_id: 'lg-innings-1',
        sport_id: 'sport-innings',
        teams: ['inn-1', 'inn-2'],
        fixtures: [{ match_id: 'm-inn-1', home: 'inn-1', away: 'inn-2' }],
      });

      // Play m-inn-1: inn-2 wins away
      await request(app).post('/audit/v1/events').send({ event_id: 'ie1', match_id: 'm-inn-1', type: 'match_start', payload: {} });
      // inn-1 scores 4 runs
      await request(app).post('/audit/v1/events').send({ event_id: 'ie2', match_id: 'm-inn-1', type: 'score', payload: { team_id: 'inn-1', event_type: 'boundary' } });
      // inn-2 scores 8 runs
      await request(app).post('/audit/v1/events').send({ event_id: 'ie3', match_id: 'm-inn-1', type: 'score', payload: { team_id: 'inn-2', event_type: 'boundary' } });
      await request(app).post('/audit/v1/events').send({ event_id: 'ie4', match_id: 'm-inn-1', type: 'score', payload: { team_id: 'inn-2', event_type: 'boundary' } });
      await request(app).post('/audit/v1/events').send({ event_id: 'ie5', match_id: 'm-inn-1', type: 'match_end', payload: {} });

      const res = await request(app).get('/audit/v1/standings/lg-innings-1');
      expect(res.status).toBe(200);
      expect(res.body.table[0].team_id).toBe('inn-2');
      expect(res.body.table[0].won).toBe(1);
      expect(typeof res.body.table[0].diff).toBe('number');
    });
  });
});
