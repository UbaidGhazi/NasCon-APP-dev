'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const config = require('../src/config');
const { issueToken, verifyToken, can } = require('../src/security');

describe('RBAC & Security (§5.13)', () => {
  let tokens;
  let context;

  beforeAll(async () => {
    // Mock q for database lookups so unit tests pass deterministically without DB
    jest.spyOn(config, 'q').mockImplementation(async (sql, params) => {
      const p0 = params && params[0];
      if (sql.includes('FROM leagues')) {
        if (p0 === 'league-alpha-1') return { rows: [{ league_id: 'league-alpha-1', tenant_id: 'tenant-alpha' }] };
        if (p0 === 'league-alpha-2') return { rows: [{ league_id: 'league-alpha-2', tenant_id: 'tenant-alpha' }] };
        if (p0 === 'league-beta-1') return { rows: [{ league_id: 'league-beta-1', tenant_id: 'tenant-beta' }] };
        return { rows: [] };
      }
      if (sql.includes('FROM clubs')) {
        if (p0 === 'club-alpha-1') return { rows: [{ club_id: 'club-alpha-1', tenant_id: 'tenant-alpha' }] };
        if (p0 === 'club-alpha-2') return { rows: [{ club_id: 'club-alpha-2', tenant_id: 'tenant-alpha' }] };
        if (p0 === 'club-beta-1') return { rows: [{ club_id: 'club-beta-1', tenant_id: 'tenant-beta' }] };
        return { rows: [] };
      }
      if (sql.includes('FROM players')) {
        if (p0 === 'player-alpha-1') return { rows: [{ player_id: 'player-alpha-1', club_id: 'club-alpha-1' }] };
        if (p0 === 'player-alpha-2') return { rows: [{ player_id: 'player-alpha-2', club_id: 'club-alpha-2' }] };
        if (p0 === 'player-beta-1') return { rows: [{ player_id: 'player-beta-1', club_id: 'club-beta-1' }] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    jest.spyOn(config.redis, 'multi').mockReturnValue({
      zremrangebyscore() { return this; },
      zadd() { return this; },
      zcard() { return this; },
      pexpire() { return this; },
      exec: async () => [[null, 1], [null, 1], [null, 1], [null, 1]],
    });

    const res = await request(app).post('/audit/v1/rbac-matrix');
    expect(res.status).toBe(200);
    tokens = res.body.tokens;
    context = res.body.context;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
  });

  describe('POST /rbac-matrix', () => {
    test('returns tokens and context with all 5 roles', () => {
      expect(tokens).toHaveProperty('super_admin');
      expect(tokens).toHaveProperty('league_organizer');
      expect(tokens).toHaveProperty('club_manager');
      expect(tokens).toHaveProperty('player');
      expect(tokens).toHaveProperty('viewer');
      expect(context.tenant_id).toBe('tenant-alpha');
      expect(context.foreign_tenant_id).toBe('tenant-beta');
    });
  });

  describe('JWT validation rules', () => {
    test('missing header returns 401 UNAUTHENTICATED', async () => {
      const res = await request(app).get('/audit/v1/rbac/platform/config');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    test('malformed bearer header returns 401', async () => {
      const res = await request(app)
        .get('/audit/v1/rbac/platform/config')
        .set('Authorization', 'Basic 12345');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    test('tampered signature returns 401', async () => {
      const valid = tokens.super_admin;
      const tampered = valid.slice(0, -5) + 'abcde';
      const res = await request(app)
        .get('/audit/v1/rbac/platform/config')
        .set('Authorization', `Bearer ${tampered}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    test('alg:none token returns 401 UNAUTHENTICATED', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url');
      const noneToken = `${header}.${payload}.`;
      const res = await request(app)
        .get('/audit/v1/rbac/platform/config')
        .set('Authorization', `Bearer ${noneToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    test('expired token returns 401', async () => {
      const expiredToken = jwt.sign(
        { user_id: 'test', role: 'super_admin' },
        config.env.jwtSecret,
        { algorithm: 'HS256', expiresIn: '-1s' }
      );
      const res = await request(app)
        .get('/audit/v1/rbac/platform/config')
        .set('Authorization', `Bearer ${expiredToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('Probe matrix verification', () => {
    // P1 POST /rbac/tenants
    test('P1: Super Admin allowed, all others 403', async () => {
      const rSuper = await request(app).post('/audit/v1/rbac/tenants').set('Authorization', `Bearer ${tokens.super_admin}`);
      expect(rSuper.status).toBe(200);

      for (const role of ['league_organizer', 'club_manager', 'player', 'viewer']) {
        const r = await request(app).post('/audit/v1/rbac/tenants').set('Authorization', `Bearer ${tokens[role]}`);
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('FORBIDDEN');
      }
    });

    // P2 POST /rbac/leagues/:league_id/fixtures
    test('P2: own league vs other league vs foreign league', async () => {
      // Super Admin: always 200
      expect((await request(app).post(`/audit/v1/rbac/leagues/${context.own_league_id}/fixtures`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);
      expect((await request(app).post(`/audit/v1/rbac/leagues/${context.other_league_id}/fixtures`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);
      expect((await request(app).post(`/audit/v1/rbac/leagues/${context.foreign_league_id}/fixtures`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);

      // Organizer: own league 200, other league 403, foreign league 403
      expect((await request(app).post(`/audit/v1/rbac/leagues/${context.own_league_id}/fixtures`).set('Authorization', `Bearer ${tokens.league_organizer}`)).status).toBe(200);
      expect((await request(app).post(`/audit/v1/rbac/leagues/${context.other_league_id}/fixtures`).set('Authorization', `Bearer ${tokens.league_organizer}`)).status).toBe(403);
      expect((await request(app).post(`/audit/v1/rbac/leagues/${context.foreign_league_id}/fixtures`).set('Authorization', `Bearer ${tokens.league_organizer}`)).status).toBe(403);

      // Others: 403
      for (const role of ['club_manager', 'player', 'viewer']) {
        expect((await request(app).post(`/audit/v1/rbac/leagues/${context.own_league_id}/fixtures`).set('Authorization', `Bearer ${tokens[role]}`)).status).toBe(403);
      }
    });

    // P3 POST /rbac/clubs/:club_id/roster and P4 POST /rbac/clubs/:club_id/products
    test('P3 & P4: own club vs other club vs foreign club', async () => {
      for (const path of ['roster', 'products']) {
        // Super: 200
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.own_club_id}/${path}`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);

        // Organizer: 403
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.own_club_id}/${path}`).set('Authorization', `Bearer ${tokens.league_organizer}`)).status).toBe(403);

        // Club Mgr: own club 200, other club 403, foreign club 403
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.own_club_id}/${path}`).set('Authorization', `Bearer ${tokens.club_manager}`)).status).toBe(200);
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.other_club_id}/${path}`).set('Authorization', `Bearer ${tokens.club_manager}`)).status).toBe(403);
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.foreign_club_id}/${path}`).set('Authorization', `Bearer ${tokens.club_manager}`)).status).toBe(403);

        // Player / Viewer: 403
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.own_club_id}/${path}`).set('Authorization', `Bearer ${tokens.player}`)).status).toBe(403);
        expect((await request(app).post(`/audit/v1/rbac/clubs/${context.own_club_id}/${path}`).set('Authorization', `Bearer ${tokens.viewer}`)).status).toBe(403);
      }
    });

    // P5 PATCH /rbac/players/:player_id
    test('P5: own player vs other player vs foreign player', async () => {
      // Super Admin: 200
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.own_player_id}`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);

      // Organizer: 403
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.own_player_id}`).set('Authorization', `Bearer ${tokens.league_organizer}`)).status).toBe(403);

      // Club Mgr (of club-alpha-1): own player (alpha-1) 200, other player (alpha-2) 403, foreign player (beta-1) 403
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.own_player_id}`).set('Authorization', `Bearer ${tokens.club_manager}`)).status).toBe(200);
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.other_player_id}`).set('Authorization', `Bearer ${tokens.club_manager}`)).status).toBe(403);
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.foreign_player_id}`).set('Authorization', `Bearer ${tokens.club_manager}`)).status).toBe(403);

      // Player: own player (self) 200, other player 403, foreign player 403
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.own_player_id}`).set('Authorization', `Bearer ${tokens.player}`)).status).toBe(200);
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.other_player_id}`).set('Authorization', `Bearer ${tokens.player}`)).status).toBe(403);
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.foreign_player_id}`).set('Authorization', `Bearer ${tokens.player}`)).status).toBe(403);

      // Viewer: 403
      expect((await request(app).patch(`/audit/v1/rbac/players/${context.own_player_id}`).set('Authorization', `Bearer ${tokens.viewer}`)).status).toBe(403);
    });

    // P6 GET /rbac/clubs/:club_id
    test('P6: own/other club (alpha) 200 for all roles; foreign club 403 for non-super', async () => {
      // Super: 200 for all
      expect((await request(app).get(`/audit/v1/rbac/clubs/${context.own_club_id}`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);
      expect((await request(app).get(`/audit/v1/rbac/clubs/${context.other_club_id}`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);
      expect((await request(app).get(`/audit/v1/rbac/clubs/${context.foreign_club_id}`).set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);

      // All roles in tenant-alpha get 200 on own and other club in tenant-alpha, but 403 on foreign club
      for (const role of ['league_organizer', 'club_manager', 'player', 'viewer']) {
        expect((await request(app).get(`/audit/v1/rbac/clubs/${context.own_club_id}`).set('Authorization', `Bearer ${tokens[role]}`)).status).toBe(200);
        expect((await request(app).get(`/audit/v1/rbac/clubs/${context.other_club_id}`).set('Authorization', `Bearer ${tokens[role]}`)).status).toBe(200);

        const foreignRes = await request(app).get(`/audit/v1/rbac/clubs/${context.foreign_club_id}`).set('Authorization', `Bearer ${tokens[role]}`);
        expect(foreignRes.status).toBe(403);
        expect(foreignRes.body.error.code).toBe('FORBIDDEN');
      }
    });

    // P7 GET /rbac/platform/config
    test('P7: Super Admin 200, all other roles 403', async () => {
      expect((await request(app).get('/audit/v1/rbac/platform/config').set('Authorization', `Bearer ${tokens.super_admin}`)).status).toBe(200);
      for (const role of ['league_organizer', 'club_manager', 'player', 'viewer']) {
        const res = await request(app).get('/audit/v1/rbac/platform/config').set('Authorization', `Bearer ${tokens[role]}`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    test('Non-existent ID returns 404', async () => {
      const res = await request(app)
        .post('/audit/v1/rbac/leagues/league-nonexistent/fixtures')
        .set('Authorization', `Bearer ${tokens.super_admin}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LEAGUE_NOT_FOUND');
    });

    test('can() function handles unknown probes gracefully and covers all role branches', () => {
      expect(can('super_admin', 'UNKNOWN_PROBE', null, null, {})).toBe(false);
      expect(can('unknown_role', 'P1', null, null, {})).toBe(false);

      const roles = ['super_admin', 'league_organizer', 'club_manager', 'player', 'viewer'];
      const probes = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
      for (const p of probes) {
        for (const r of roles) {
          can(r, p, null, { league_id: 'l1', club_id: 'c1', player_id: 'p1', tenant_id: 't1' }, { league_id: 'l1', club_id: 'c1', player_id: 'p1', tenant_id: 't1' });
        }
      }
    });
  });

  describe('Middleware (bodySizeGuard & rateLimit)', () => {
    test('rejects body > 1MB with 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await request(app)
        .post('/audit/v1/reset')
        .set('Content-Length', '2000000')
        .send('a');
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('GET /api/v1/ping succeeds and exercises rate limit middleware', async () => {
      const res = await request(app).get('/api/v1/ping');
      expect(res.status).toBe(200);
      expect(res.body.pong).toBe(true);
    });
  });
});
