'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');

describe('Offline Sync (§5.14)', () => {
  const offlineActions = new Map();
  const matches = new Map();
  const sports = new Map();
  const events = [];

  beforeAll(() => {
    process.env.DAY1_SALT = process.env.DAY1_SALT || 'test-salt';

    sports.set('sport-off', {
      sport_id: 'sport-off',
      scoring_model: 'event',
      periods: { count: 2, duration_minutes: 45 },
      scoring_events: { pt: { points: 1 } },
      draw_allowed: true,
      overtime: { policy: 'none' },
      tie_break_order: ['h2h_points', 'draw_lots'],
      roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} },
    });

    matches.set('m-off-1', {
      match_id: 'm-off-1',
      sport_id: 'sport-off',
      home_team_id: 't1',
      away_team_id: 't2',
    });

    events.push({
      match_id: 'm-off-1',
      event_id: 'e-init',
      seq: 1,
      type: 'match_start',
      payload: {},
      signature: 'dummy',
      compensated: false,
      body_hash: 'h0',
      response: {},
    });

    const mockQuery = async (sql, params = []) => {
      // offline_actions
      if (sql.includes('FROM offline_actions WHERE device_id = $1 AND action_id = $2')) {
        const key = `${params[0]}:${params[1]}`;
        const res = offlineActions.get(key);
        return { rows: res ? [{ result: res }] : [] };
      }
      if (sql.includes('INSERT INTO offline_actions')) {
        const key = `${params[0]}:${params[1]}`;
        const val = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
        offlineActions.set(key, val);
        return { rowCount: 1 };
      }

      // count match_events
      if (sql.includes('SELECT count(*) FROM match_events WHERE match_id = $1')) {
        const count = events.filter((e) => e.match_id === params[0]).length;
        return { rows: [{ count }] };
      }
      // match_events list
      if (sql.includes('FROM match_events WHERE match_id = $1 ORDER BY seq ASC')) {
        const list = events.filter((e) => e.match_id === params[0]).sort((a, b) => a.seq - b.seq);
        return { rows: list };
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

      // matches
      if (sql.includes('FROM matches WHERE match_id = $1')) {
        const m = matches.get(params[0]);
        return { rows: m ? [m] : [] };
      }
      // sports
      if (sql.includes('FROM sports WHERE sport_id = $1')) {
        const s = sports.get(params[0]);
        return { rows: s ? [s] : [] };
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

  test('POST /audit/v1/offline-sync: applied, rebased_append, and INVALID_BASE_VERSION', async () => {
    // Current match events count = 1
    const syncReq = {
      device_id: 'dev-1',
      actions: [
        {
          action_id: 'act-1',
          type: 'score_event',
          queued_at: '2026-10-17T10:00:00Z',
          base_version: 1, // matches current version (1) -> appended
          payload: {
            event_id: 'ev-sync-1',
            match_id: 'm-off-1',
            type: 'score',
            payload: { team_id: 't1', event_type: 'pt' },
          },
        },
        {
          action_id: 'act-2',
          type: 'score_event',
          queued_at: '2026-10-17T10:01:00Z',
          base_version: 1, // now current is 2, so base_version (1) < current (2) -> rebased_append
          payload: {
            event_id: 'ev-sync-2',
            match_id: 'm-off-1',
            type: 'score',
            payload: { team_id: 't2', event_type: 'pt' },
          },
        },
        {
          action_id: 'act-3',
          type: 'score_event',
          queued_at: '2026-10-17T10:02:00Z',
          base_version: 99, // base_version > current -> INVALID_BASE_VERSION
          payload: {
            event_id: 'ev-sync-3',
            match_id: 'm-off-1',
            type: 'score',
            payload: { team_id: 't1', event_type: 'pt' },
          },
        },
      ],
    };

    const res = await request(app).post('/audit/v1/offline-sync').send(syncReq);
    expect(res.status).toBe(200);
    expect(res.body.summary.applied).toBe(2);
    expect(res.body.summary.rejected).toBe(1);
    expect(res.body.summary.duplicate).toBe(0);

    const r0 = res.body.results[0];
    expect(r0.status).toBe('applied');
    expect(r0.resolution).toBe('appended');
    expect(r0.signature).toBeDefined();

    const r1 = res.body.results[1];
    expect(r1.status).toBe('applied');
    expect(r1.resolution).toBe('rebased_append');

    const r2 = res.body.results[2];
    expect(r2.status).toBe('rejected');
    expect(r2.resolution).toBe('server_wins');
    expect(r2.error_code).toBe('INVALID_BASE_VERSION');
  });

  test('duplicate detection on identical re-send', async () => {
    const syncReq = {
      device_id: 'dev-1',
      actions: [
        {
          action_id: 'act-1',
          type: 'score_event',
          queued_at: '2026-10-17T10:00:00Z',
          base_version: 1,
          payload: {
            event_id: 'ev-sync-1',
            match_id: 'm-off-1',
            type: 'score',
            payload: { team_id: 't1', event_type: 'pt' },
          },
        },
      ],
    };

    const res = await request(app).post('/audit/v1/offline-sync').send(syncReq);
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('duplicate');
    expect(res.body.results[0].resolution).toBe('skipped_duplicate');
    expect(res.body.summary.duplicate).toBe(1);
  });
});
