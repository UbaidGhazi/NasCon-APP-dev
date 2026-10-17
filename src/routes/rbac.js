'use strict';
/**
 * Express router for /audit/v1 RBAC matrix and security probes.
 */

const express = require('express');
const { asyncH, forbidden, notFound } = require('../errors');
const config = require('../config');
const { issueToken, verifyToken, can } = require('../security');
const { DEMO_USERS } = require('../seed');

const router = express.Router();

// Middleware to authenticate via Bearer token
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const actor = verifyToken(authHeader);
  req.actor = actor;
  next();
}

/**
 * POST /rbac-matrix
 * No auth, no body -> returns tokens and scenario context.
 */
router.post(
  '/rbac-matrix',
  asyncH(async (req, res) => {
    // Demo accounts from DEMO_USERS
    const usersByRole = {};
    for (const u of DEMO_USERS) {
      usersByRole[u.role] = u;
    }

    const tokens = {
      super_admin: issueToken(usersByRole.super_admin),
      league_organizer: issueToken(usersByRole.league_organizer),
      club_manager: issueToken(usersByRole.club_manager),
      player: issueToken(usersByRole.player),
      viewer: issueToken(usersByRole.viewer),
    };

    const context = {
      tenant_id: 'tenant-alpha',
      foreign_tenant_id: 'tenant-beta',
      own_league_id: 'league-alpha-1',
      other_league_id: 'league-alpha-2',
      foreign_league_id: 'league-beta-1',
      own_club_id: 'club-alpha-1',
      other_club_id: 'club-alpha-2',
      foreign_club_id: 'club-beta-1',
      own_player_id: 'player-alpha-1',
      other_player_id: 'player-alpha-2',
      foreign_player_id: 'player-beta-1',
    };

    res.status(200).json({ tokens, context });
  })
);

/**
 * P1: POST /rbac/tenants
 * Super admin only.
 */
router.post(
  '/rbac/tenants',
  authenticate,
  asyncH(async (req, res) => {
    if (!can(req.actor.role, 'P1', null, null, req.actor)) {
      throw forbidden();
    }
    res.status(200).json({ authorized: true });
  })
);

/**
 * P2: POST /rbac/leagues/:league_id/fixtures
 * Super admin or own-league organizer.
 */
router.post(
  '/rbac/leagues/:league_id/fixtures',
  authenticate,
  asyncH(async (req, res) => {
    const { league_id } = req.params;
    // Authorization evaluated first
    if (req.actor.role !== 'super_admin' && req.actor.role !== 'league_organizer') {
      throw forbidden();
    }

    const r = await config.q('SELECT league_id, tenant_id FROM leagues WHERE league_id = $1', [league_id]);
    if (r.rows.length === 0) {
      throw notFound('LEAGUE_NOT_FOUND', { league_id });
    }

    const target = r.rows[0];
    if (!can(req.actor.role, 'P2', 'league', target, req.actor)) {
      throw forbidden();
    }

    res.status(200).json({ authorized: true });
  })
);

/**
 * P3: POST /rbac/clubs/:club_id/roster
 * Super admin or own-club manager.
 */
router.post(
  '/rbac/clubs/:club_id/roster',
  authenticate,
  asyncH(async (req, res) => {
    const { club_id } = req.params;
    if (req.actor.role !== 'super_admin' && req.actor.role !== 'club_manager') {
      throw forbidden();
    }

    const r = await config.q('SELECT club_id, tenant_id FROM clubs WHERE club_id = $1', [club_id]);
    if (r.rows.length === 0) {
      throw notFound('CLUB_NOT_FOUND', { club_id });
    }

    const target = r.rows[0];
    if (!can(req.actor.role, 'P3', 'club', target, req.actor)) {
      throw forbidden();
    }

    res.status(200).json({ authorized: true });
  })
);

/**
 * P4: POST /rbac/clubs/:club_id/products
 * Super admin or own-club manager.
 */
router.post(
  '/rbac/clubs/:club_id/products',
  authenticate,
  asyncH(async (req, res) => {
    const { club_id } = req.params;
    if (req.actor.role !== 'super_admin' && req.actor.role !== 'club_manager') {
      throw forbidden();
    }

    const r = await config.q('SELECT club_id, tenant_id FROM clubs WHERE club_id = $1', [club_id]);
    if (r.rows.length === 0) {
      throw notFound('CLUB_NOT_FOUND', { club_id });
    }

    const target = r.rows[0];
    if (!can(req.actor.role, 'P4', 'club', target, req.actor)) {
      throw forbidden();
    }

    res.status(200).json({ authorized: true });
  })
);

/**
 * P5: PATCH /rbac/players/:player_id
 * Super admin, player's club manager, or the player themselves.
 */
router.patch(
  '/rbac/players/:player_id',
  authenticate,
  asyncH(async (req, res) => {
    const { player_id } = req.params;
    if (req.actor.role === 'league_organizer' || req.actor.role === 'viewer') {
      throw forbidden();
    }

    const r = await config.q('SELECT player_id, club_id FROM players WHERE player_id = $1', [player_id]);
    if (r.rows.length === 0) {
      throw notFound('PLAYER_NOT_FOUND', { player_id });
    }

    const target = r.rows[0];
    if (!can(req.actor.role, 'P5', 'player', target, req.actor)) {
      throw forbidden();
    }

    res.status(200).json({ authorized: true });
  })
);

/**
 * P6: GET /rbac/clubs/:club_id
 * Super admin or anyone in the same tenant.
 */
router.get(
  '/rbac/clubs/:club_id',
  authenticate,
  asyncH(async (req, res) => {
    const { club_id } = req.params;
    const r = await config.q('SELECT club_id, tenant_id FROM clubs WHERE club_id = $1', [club_id]);
    if (r.rows.length === 0) {
      throw notFound('CLUB_NOT_FOUND', { club_id });
    }

    const target = r.rows[0];
    if (!can(req.actor.role, 'P6', 'club', target, req.actor)) {
      throw forbidden();
    }

    res.status(200).json({ authorized: true });
  })
);

/**
 * P7: GET /rbac/platform/config
 * Super admin only.
 */
router.get(
  '/rbac/platform/config',
  authenticate,
  asyncH(async (req, res) => {
    if (!can(req.actor.role, 'P7', null, null, req.actor)) {
      throw forbidden();
    }
    res.status(200).json({ authorized: true });
  })
);

module.exports = router;
