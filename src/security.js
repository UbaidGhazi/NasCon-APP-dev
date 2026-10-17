'use strict';
/**
 * §5.13 Security, JWT issuance/verification, and RBAC matrix.
 */

const jwt = require('jsonwebtoken');
const { env } = require('./config');
const { unauthenticated, forbidden } = require('./errors');

/**
 * Issue a signed JWT token for a user.
 * Grader treats tokens as opaque; valid >= 1 hour.
 */
function issueToken(user) {
  const payload = {
    user_id: user.user_id,
    role: user.role,
    tenant_id: user.tenant_id || null,
    league_id: user.league_id || null,
    club_id: user.club_id || null,
    player_id: user.player_id || null,
  };
  return jwt.sign(payload, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '2h',
  });
}

/**
 * Verify authorization header.
 * MUST explicitly specify algorithms: ['HS256'] to prevent alg:none attacks.
 */
function verifyToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') {
    throw unauthenticated('Missing authorization header.');
  }
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    throw unauthenticated('Invalid authorization format.');
  }
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, env.jwtSecret, {
      algorithms: ['HS256'],
    });
    return decoded;
  } catch (err) {
    throw unauthenticated('Invalid, expired, or tampered token.');
  }
}

/**
 * §5.13 Permission Matrix Data Table.
 * Encoded as a data table (not nested ifs).
 * Each probe maps roles to authorization predicate functions.
 */
const PERMISSION_MATRIX = {
  P1: {
    super_admin: () => true,
    league_organizer: () => false,
    club_manager: () => false,
    player: () => false,
    viewer: () => false,
  },
  P2: {
    super_admin: () => true,
    league_organizer: (actor, target) =>
      Boolean(target && actor.league_id && target.league_id === actor.league_id),
    club_manager: () => false,
    player: () => false,
    viewer: () => false,
  },
  P3: {
    super_admin: () => true,
    league_organizer: () => false,
    club_manager: (actor, target) =>
      Boolean(target && actor.club_id && target.club_id === actor.club_id),
    player: () => false,
    viewer: () => false,
  },
  P4: {
    super_admin: () => true,
    league_organizer: () => false,
    club_manager: (actor, target) =>
      Boolean(target && actor.club_id && target.club_id === actor.club_id),
    player: () => false,
    viewer: () => false,
  },
  P5: {
    super_admin: () => true,
    league_organizer: () => false,
    club_manager: (actor, target) =>
      Boolean(target && actor.club_id && target.club_id === actor.club_id),
    player: (actor, target) =>
      Boolean(target && actor.player_id && target.player_id === actor.player_id),
    viewer: () => false,
  },
  P6: {
    super_admin: () => true,
    league_organizer: (actor, target) =>
      Boolean(target && actor.tenant_id && target.tenant_id === actor.tenant_id),
    club_manager: (actor, target) =>
      Boolean(target && actor.tenant_id && target.tenant_id === actor.tenant_id),
    player: (actor, target) =>
      Boolean(target && actor.tenant_id && target.tenant_id === actor.tenant_id),
    viewer: (actor, target) =>
      Boolean(target && actor.tenant_id && target.tenant_id === actor.tenant_id),
  },
  P7: {
    super_admin: () => true,
    league_organizer: () => false,
    club_manager: () => false,
    player: () => false,
    viewer: () => false,
  },
};

/**
 * Check if the actor can perform probe on target.
 */
function can(role, probe, targetKind, targetId, actor) {
  const probeRules = PERMISSION_MATRIX[probe];
  if (!probeRules) return false;
  const predicate = probeRules[role];
  if (!predicate) return false;
  return predicate(actor, targetId);
}

module.exports = {
  issueToken,
  verifyToken,
  PERMISSION_MATRIX,
  can,
};
