'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');

describe('Event-sourced Scoring Engine (§5.8, §5.9)', () => {
  const matches = new Map();
  const sports = new Map();
  const events = [];

  beforeAll(() => {
    process.env.DAY1_SALT = process.env.DAY1_SALT || 'test-salt';
    // Setup seeded sports in mock
    sports.set('sport-event', {
      sport_id: 'sport-event',
      scoring_model: 'event',
      periods: { count: 2, duration_minutes: 45 },
      scoring_events: { point: { points: 1 }, major: { points: 3 } },
      draw_allowed: false,
      overtime: { policy: 'none' },
      tie_break_order: ['h2h_points', 'draw_lots'],
      roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
    });

    sports.set('sport-draw-allowed', {
      sport_id: 'sport-draw-allowed',
      scoring_model: 'event',
      periods: { count: 2, duration_minutes: 45 },
      scoring_events: { point: { points: 1 } },
      draw_allowed: true,
      overtime: { policy: 'none' },
      tie_break_order: ['h2h_points', 'draw_lots'],
      roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
    });

    sports.set('sport-innings', {
      sport_id: 'sport-innings',
      scoring_model: 'innings',
      periods: { innings_per_team: 1, overs_per_innings: 2, balls_per_over: 6, wickets_per_innings: 2 },
      scoring_events: {
        run1: { runs: 1, legal_ball: true, wicket: false },
        dot: { runs: 0, legal_ball: true, wicket: false },
        out: { runs: 0, legal_ball: true, wicket: true },
        extra: { runs: 1, legal_ball: false, wicket: false },
      },
      draw_allowed: true,
      overtime: { policy: 'super_over' },
      tie_break_order: ['h2h_points', 'draw_lots'],
      roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
    });

    sports.set('sport-round', {
      sport_id: 'sport-round',
      scoring_model: 'round',
      periods: { best_of: 3 },
      scoring_events: { r_win: { rounds: 1 } },
      draw_allowed: false,
      overtime: { policy: 'none' },
      tie_break_order: ['h2h_points', 'draw_lots'],
      roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
    });

    const mockQuery = async (sql, params = []) => {
      // Matches
      if (sql.includes('FROM matches WHERE match_id = $1')) {
        const m = matches.get(params[0]);
        return { rows: m ? [m] : [] };
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

      // Sports
      if (sql.includes('FROM sports WHERE sport_id = $1')) {
        const s = sports.get(params[0]);
        return { rows: s ? [s] : [] };
      }

      // Events
      if (sql.includes('FROM match_events WHERE event_id = $1')) {
        const ev = events.find((e) => e.event_id === params[0]);
        return { rows: ev ? [ev] : [] };
      }
      if (sql.includes('FROM match_events WHERE match_id = $1 ORDER BY seq ASC')) {
        const matchEvs = events.filter((e) => e.match_id === params[0]).sort((a, b) => a.seq - b.seq);
        return { rows: matchEvs };
      }
      if (sql.includes('INSERT INTO match_events')) {
        const newEv = {
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
        };
        events.push(newEv);
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

  test('match_init creates a new match stream and returns 201 with signature', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-init-1',
        match_id: 'm-1',
        type: 'match_init',
        payload: {
          sport_id: 'sport-event',
          home_team_id: 'team-a',
          away_team_id: 'team-b',
        },
      });

    if (res.status !== 201) console.log('TEST 1 ERROR:', res.status, res.body);
    expect(res.status).toBe(201);
    expect(res.body.sequence).toBe(1);
    expect(res.body.match_version).toBe(1);
    expect(res.body.signature).toMatch(/^[0-9a-f]{64}$/);

    // Verify initial score projection
    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.status).toBe(200);
    expect(scoreRes.body.status).toBe('upcoming');
    expect(scoreRes.body.outcome).toBe('pending');
    expect(scoreRes.body.home.score).toBe(0);
  });

  test('idempotency: replay identical body returns 200, different body returns 409', async () => {
    const reqBody = {
      event_id: 'ev-init-1',
      match_id: 'm-1',
      type: 'match_init',
      payload: {
        sport_id: 'sport-event',
        home_team_id: 'team-a',
        away_team_id: 'team-b',
      },
    };

    // Replay identical -> 200
    const replayRes = await request(app).post('/audit/v1/events').send(reqBody);
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.sequence).toBe(1);

    // Different body with same event_id -> 409 DUPLICATE_EVENT_ID
    const diffRes = await request(app).post('/audit/v1/events').send({
      ...reqBody,
      payload: { ...reqBody.payload, home_team_id: 'tampered' },
    });
    expect(diffRes.status).toBe(409);
    expect(diffRes.body.error.code).toBe('DUPLICATE_EVENT_ID');
  });

  test('illegal transition: cannot score before match_start', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-score-early',
        match_id: 'm-1',
        type: 'score',
        payload: { team_id: 'team-a', event_type: 'point' },
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MATCH_NOT_IN_PROGRESS');
  });

  test('match_start transitions to in_progress', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-start-1',
        match_id: 'm-1',
        type: 'match_start',
        payload: {},
      });
    if (res.status !== 201) console.log('START ERROR:', res.status, res.body);
    expect(res.status).toBe(201);
    expect(res.body.sequence).toBe(2);

    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.body.status).toBe('in_progress');
  });

  test('score event increases team score', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-score-1',
        match_id: 'm-1',
        type: 'score',
        payload: { team_id: 'team-a', event_type: 'point' },
      });
    expect(res.status).toBe(201);

    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.body.home.score).toBe(1);
    expect(scoreRes.body.away.score).toBe(0);
  });

  test('discipline event updates fair_play points', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-disc-1',
        match_id: 'm-1',
        type: 'discipline',
        payload: { team_id: 'team-a', points: -2 },
      });
    expect(res.status).toBe(201);

    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.body.home.fair_play).toBe(-2);
  });

  test('compensation neutralises a score event without deleting it', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-comp-1',
        match_id: 'm-1',
        type: 'compensation',
        payload: { compensates: 'ev-score-1', reason: 'Disallowed point' },
      });
    expect(res.status).toBe(201);

    // Score is now 0 again!
    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.body.home.score).toBe(0);

    // Both events still appear in events array
    const ev1 = scoreRes.body.events.find((e) => e.event_id === 'ev-score-1');
    expect(ev1.compensated).toBe(true);
    expect(ev1.compensated_by).toBe('ev-comp-1');

    const compEv = scoreRes.body.events.find((e) => e.event_id === 'ev-comp-1');
    expect(compEv).toBeDefined();
  });

  test('TIE_NOT_ALLOWED when score level and draw_allowed is false without tiebreak_winner', async () => {
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-end-tie',
        match_id: 'm-1',
        type: 'match_end',
        payload: {},
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIE_NOT_ALLOWED');
  });

  test('tiebreak_winner resolves tie and allows match_end', async () => {
    // Declare team-b tiebreak winner
    await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-tb-1',
        match_id: 'm-1',
        type: 'tiebreak_winner',
        payload: { team_id: 'team-b' },
      });

    // Now match_end succeeds
    const endRes = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-end-ok',
        match_id: 'm-1',
        type: 'match_end',
        payload: {},
      });
    expect(endRes.status).toBe(201);

    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.body.status).toBe('completed');
    expect(scoreRes.body.outcome).toBe('away_win');
    expect(scoreRes.body.winner_team_id).toBe('team-b');
  });

  test('compensation on completed match makes outcome undecided when tiebreak compensated', async () => {
    // Compensate the tiebreak_winner event on this completed match
    const res = await request(app)
      .post('/audit/v1/events')
      .send({
        event_id: 'ev-comp-tb',
        match_id: 'm-1',
        type: 'compensation',
        payload: { compensates: 'ev-tb-1', reason: 'Tiebreak overturned' },
      });
    expect(res.status).toBe(201);

    const scoreRes = await request(app).get('/audit/v1/score/m-1');
    expect(scoreRes.body.status).toBe('completed');
    expect(scoreRes.body.outcome).toBe('undecided');
    expect(scoreRes.body.winner_team_id).toBeNull();
  });

  test('innings model: overs string formatting and INNINGS_COMPLETE limit', async () => {
    // Init innings match: max balls = 1 * 2 * 6 = 12 balls, max wickets = 2
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-inn-init',
      match_id: 'm-inn',
      type: 'match_init',
      payload: { sport_id: 'sport-innings', home_team_id: 'team-x', away_team_id: 'team-y' },
    });
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-inn-start',
      match_id: 'm-inn',
      type: 'match_start',
      payload: {},
    });

    // 1 run (legal) -> overs 0.1
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-inn-s1',
      match_id: 'm-inn',
      type: 'score',
      payload: { team_id: 'team-x', event_type: 'run1' },
    });

    let scoreRes = await request(app).get('/audit/v1/score/m-inn');
    expect(scoreRes.body.home.balls).toBe(1);
    expect(scoreRes.body.home.overs).toBe('0.1');

    // 2 outs -> reached max wickets (2)
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-inn-w1',
      match_id: 'm-inn',
      type: 'score',
      payload: { team_id: 'team-x', event_type: 'out' },
    });
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-inn-w2',
      match_id: 'm-inn',
      type: 'score',
      payload: { team_id: 'team-x', event_type: 'out' },
    });

    // Further score events for team-x -> 409 INNINGS_COMPLETE
    const failRes = await request(app).post('/audit/v1/events').send({
      event_id: 'ev-inn-excess',
      match_id: 'm-inn',
      type: 'score',
      payload: { team_id: 'team-x', event_type: 'run1' },
    });
    expect(failRes.status).toBe(409);
    expect(failRes.body.error.code).toBe('INNINGS_COMPLETE');
  });

  test('round model: SERIES_ALREADY_DECIDED when target rounds reached', async () => {
    // best_of: 3 -> need (3+1)/2 = 2 rounds
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-rnd-init',
      match_id: 'm-rnd',
      type: 'match_init',
      payload: { sport_id: 'sport-round', home_team_id: 'team-1', away_team_id: 'team-2' },
    });
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-rnd-start',
      match_id: 'm-rnd',
      type: 'match_start',
      payload: {},
    });

    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-rnd-r1',
      match_id: 'm-rnd',
      type: 'score',
      payload: { team_id: 'team-1', event_type: 'r_win' },
    });
    await request(app).post('/audit/v1/events').send({
      event_id: 'ev-rnd-r2',
      match_id: 'm-rnd',
      type: 'score',
      payload: { team_id: 'team-1', event_type: 'r_win' },
    });

    // 3rd round attempt -> 409 SERIES_ALREADY_DECIDED
    const failRes = await request(app).post('/audit/v1/events').send({
      event_id: 'ev-rnd-r3',
      match_id: 'm-rnd',
      type: 'score',
      payload: { team_id: 'team-1', event_type: 'r_win' },
    });
    expect(failRes.status).toBe(409);
    expect(failRes.body.error.code).toBe('SERIES_ALREADY_DECIDED');
  });
});
