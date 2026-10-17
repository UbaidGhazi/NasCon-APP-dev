'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { validateSportPayload } = require('../src/domain/sports');

describe('Sports API & Domain (§5.6)', () => {
  const sportsDb = new Map();

  beforeAll(() => {
    sportsDb.clear();
    jest.spyOn(config, 'q').mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT sport_id FROM sports WHERE sport_id = $1')) {
        const id = params[0];
        if (sportsDb.has(id)) {
          return { rows: [{ sport_id: id }] };
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO sports')) {
        const id = params[0];
        sportsDb.set(id, params);
        return { rowCount: 1 };
      }
      return { rows: [] };
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('creates a valid event-model sport', async () => {
    const payload = {
      sport_id: 'custom-event-sport',
      name: 'Custom Event Sport',
      scoring_model: 'event',
      periods: { count: 2, duration_minutes: 40 },
      scoring_events: {
        score_point: { points: 1 },
        major_score: { points: 3 },
      },
      draw_allowed: true,
      overtime: { policy: 'none' },
      tie_break_order: ['h2h_points', 'overall_diff', 'draw_lots'],
      roster: {
        min_squad_size: 5,
        max_squad_size: 15,
        required_positions: { defender: 2 },
      },
    };

    const res = await request(app).post('/audit/v1/sports').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('created');
    expect(res.body.sport_id).toBe('custom-event-sport');
    expect(res.body.config.sport_id).toBe('custom-event-sport');
    expect(res.body.config.tie_break_order).toEqual(['h2h_points', 'overall_diff', 'draw_lots']);
  });

  test('creates a valid innings-model sport and appends draw_lots if omitted', async () => {
    const payload = {
      sport_id: 'custom-innings-sport',
      name: 'Custom Innings Sport',
      scoring_model: 'innings',
      periods: {
        innings_per_team: 2,
        overs_per_innings: 10,
        balls_per_over: 6,
        wickets_per_innings: 5,
      },
      scoring_events: {
        single_run: { runs: 1, legal_ball: true, wicket: false },
        boundary: { runs: 4, legal_ball: true, wicket: false },
        out: { runs: 0, legal_ball: true, wicket: true },
      },
      draw_allowed: false,
      overtime: { policy: 'super_over' },
      tie_break_order: ['h2h_points', 'scored'],
      roster: {
        min_squad_size: 6,
        max_squad_size: 12,
        required_positions: {},
      },
    };

    const res = await request(app).post('/audit/v1/sports').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.config.tie_break_order).toEqual(['h2h_points', 'scored', 'draw_lots']);
  });

  test('creates a valid round-model sport with default tie break order', async () => {
    const payload = {
      sport_id: 'custom-round-sport',
      name: 'Custom Round Sport',
      scoring_model: 'round',
      periods: { best_of: 5 },
      scoring_events: {
        round_win: { rounds: 1 },
      },
      draw_allowed: false,
      overtime: { policy: 'extra_time', duration_minutes: 5 },
      roster: {
        min_squad_size: 3,
        max_squad_size: 7,
        required_positions: {},
      },
    };

    const res = await request(app).post('/audit/v1/sports').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.config.tie_break_order).toEqual([
      'h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'
    ]);
  });

  test('duplicate sport_id returns 409 SPORT_EXISTS', async () => {
    const payload = {
      sport_id: 'custom-event-sport',
      name: 'Duplicate Sport',
      scoring_model: 'event',
      periods: { count: 1, duration_minutes: 10 },
      scoring_events: { pt: { points: 1 } },
      draw_allowed: true,
      overtime: { policy: 'none' },
      roster: { min_squad_size: 2, max_squad_size: 4, required_positions: {} },
    };

    const res = await request(app).post('/audit/v1/sports').send(payload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SPORT_EXISTS');
  });

  test('SQL injection string in sport_id returns 400 VALIDATION_ERROR and does not crash', async () => {
    const payload = {
      sport_id: "x'; DROP TABLE sports;--",
      name: 'Injection Sport',
      scoring_model: 'event',
      periods: { count: 1, duration_minutes: 1 },
      scoring_events: { pt: { points: 1 } },
      draw_allowed: true,
      overtime: { policy: 'none' },
      roster: { min_squad_size: 1, max_squad_size: 2, required_positions: {} },
    };

    const res = await request(app).post('/audit/v1/sports').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fields).toContain('sport_id');
  });

  test('validates all schema fields and reports them in details.fields', async () => {
    const res = await request(app).post('/audit/v1/sports').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.fields;
    expect(fields).toContain('sport_id');
    expect(fields).toContain('name');
    expect(fields).toContain('scoring_model');
    expect(fields).toContain('periods');
    expect(fields).toContain('scoring_events');
    expect(fields).toContain('draw_allowed');
    expect(fields).toContain('overtime');
    expect(fields).toContain('roster');
  });

  test('validates model-specific period constraints and tie_break_order errors', () => {
    // Round model with even best_of
    expect(() =>
      validateSportPayload({
        sport_id: 'test-even',
        name: 'Test',
        scoring_model: 'round',
        periods: { best_of: 4 },
        scoring_events: { r: { rounds: 1 } },
        draw_allowed: false,
        overtime: { policy: 'none' },
        roster: { min_squad_size: 1, max_squad_size: 2, required_positions: {} },
      })
    ).toThrow();

    // Invalid tie_break_order with duplicates or unknown keys
    expect(() =>
      validateSportPayload({
        sport_id: 'test-tb',
        name: 'Test',
        scoring_model: 'event',
        periods: { count: 1, duration_minutes: 10 },
        scoring_events: { p: { points: 1 } },
        draw_allowed: true,
        overtime: { policy: 'none' },
        tie_break_order: ['h2h_points', 'h2h_points'],
        roster: { min_squad_size: 1, max_squad_size: 2, required_positions: {} },
      })
    ).toThrow();

    // Invalid roster min > max
    expect(() =>
      validateSportPayload({
        sport_id: 'test-roster',
        name: 'Test',
        scoring_model: 'event',
        periods: { count: 1, duration_minutes: 10 },
        scoring_events: { p: { points: 1 } },
        draw_allowed: true,
        overtime: { policy: 'none' },
        roster: { min_squad_size: 5, max_squad_size: 2, required_positions: {} },
      })
    ).toThrow();
  });
});
