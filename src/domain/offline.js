'use strict';
/**
 * Offline action sync engine (§5.14).
 * Reuses appendEvent and transfer directly without duplicating rules.
 */

const config = require('../config');
const { validation } = require('../errors');
const { appendEvent } = require('./scoring');
const { transfer } = require('./roster');

async function processOfflineSync(clientOrPool, body) {
  // Validate envelope
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validation(['body'], 'Payload must be an object.');
  }
  const { device_id, actions } = body;
  if (!device_id || typeof device_id !== 'string') {
    throw validation(['device_id'], 'device_id is required.');
  }
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100) {
    throw validation(['actions'], 'actions must be an array of 1 to 100 actions.');
  }

  // Validate action items schema
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    if (
      !act ||
      !act.action_id ||
      !['score_event', 'roster_transfer'].includes(act.type) ||
      !act.queued_at ||
      act.base_version === undefined ||
      !Number.isInteger(act.base_version) ||
      !act.payload ||
      typeof act.payload !== 'object'
    ) {
      throw validation([`actions[${i}]`], 'Invalid action schema in offline sync.');
    }
  }

  const execute = async (c) => {
    // Tag each action with original request index
    const indexedActions = actions.map((act, originalIndex) => ({
      ...act,
      originalIndex,
    }));

    // Sort by queued_at ascending (ties preserve original order)
    indexedActions.sort((a, b) => {
      if (a.queued_at < b.queued_at) return -1;
      if (a.queued_at > b.queued_at) return 1;
      return a.originalIndex - b.originalIndex;
    });

    const resultMap = new Map(); // originalIndex -> result object
    let appliedCount = 0;
    let rejectedCount = 0;
    let duplicateCount = 0;

    for (let pIdx = 0; pIdx < indexedActions.length; pIdx++) {
      const act = indexedActions[pIdx];
      const processed_order = pIdx + 1;

      // 1. Check if (device_id, action_id) seen before
      const seenRes = await c.query(
        'SELECT result FROM offline_actions WHERE device_id = $1 AND action_id = $2',
        [device_id, act.action_id]
      );

      if (seenRes.rows.length > 0) {
        const prev = seenRes.rows[0].result;
        duplicateCount++;
        resultMap.set(act.originalIndex, {
          action_id: act.action_id,
          status: 'duplicate',
          resolution: 'skipped_duplicate',
          error_code: null,
          processed_order,
          server_version: prev.server_version,
          signature: null,
        });
        continue;
      }

      // 2. Fetch current version
      let currentVersion = 0;
      let targetNotFoundCode = null;

      if (act.type === 'score_event') {
        const matchId = act.payload.match_id;
        const mRes = await c.query('SELECT match_id FROM matches WHERE match_id = $1', [matchId]);
        if (mRes.rows.length === 0 && act.payload.type !== 'match_init') {
          targetNotFoundCode = 'MATCH_NOT_FOUND';
        } else {
          const countRes = await c.query(
            'SELECT count(*) FROM match_events WHERE match_id = $1',
            [matchId]
          );
          currentVersion = Number(countRes.rows[0].count);
        }
      } else if (act.type === 'roster_transfer') {
        const playerId = act.payload.player_id;
        const pRes = await c.query('SELECT player_id FROM players WHERE player_id = $1', [playerId]);
        if (pRes.rows.length === 0) {
          targetNotFoundCode = 'PLAYER_NOT_FOUND';
        } else {
          const countRes = await c.query(
            'SELECT count(*) FROM roster_audit WHERE player_id = $1',
            [playerId]
          );
          currentVersion = Number(countRes.rows[0].count);
        }
      }

      if (targetNotFoundCode) {
        rejectedCount++;
        const resObj = {
          action_id: act.action_id,
          status: 'rejected',
          resolution: 'server_wins',
          error_code: targetNotFoundCode,
          processed_order,
          server_version: currentVersion,
          signature: null,
        };
        await c.query(
          'INSERT INTO offline_actions (device_id, action_id, result) VALUES ($1, $2, $3)',
          [device_id, act.action_id, JSON.stringify(resObj)]
        );
        resultMap.set(act.originalIndex, resObj);
        continue;
      }

      // Check base_version > current
      if (act.base_version > currentVersion) {
        rejectedCount++;
        const resObj = {
          action_id: act.action_id,
          status: 'rejected',
          resolution: 'server_wins',
          error_code: 'INVALID_BASE_VERSION',
          processed_order,
          server_version: currentVersion,
          signature: null,
        };
        await c.query(
          'INSERT INTO offline_actions (device_id, action_id, result) VALUES ($1, $2, $3)',
          [device_id, act.action_id, JSON.stringify(resObj)]
        );
        resultMap.set(act.originalIndex, resObj);
        continue;
      }

      // Process action
      try {
        let actionResult = null;
        let eventSig = null;

        if (act.type === 'score_event') {
          actionResult = await appendEvent(c, act.payload);
          if (actionResult.isReplay) {
            duplicateCount++;
            const resObj = {
              action_id: act.action_id,
              status: 'duplicate',
              resolution: 'skipped_duplicate',
              error_code: null,
              processed_order,
              server_version: currentVersion,
              signature: null,
            };
            await c.query(
              'INSERT INTO offline_actions (device_id, action_id, result) VALUES ($1, $2, $3)',
              [device_id, act.action_id, JSON.stringify(resObj)]
            );
            resultMap.set(act.originalIndex, resObj);
            continue;
          }
          eventSig = actionResult.response ? actionResult.response.signature : null;
        } else if (act.type === 'roster_transfer') {
          actionResult = await transfer(c, act.payload);
          if (actionResult.status === 200) {
            duplicateCount++;
            const resObj = {
              action_id: act.action_id,
              status: 'duplicate',
              resolution: 'skipped_duplicate',
              error_code: null,
              processed_order,
              server_version: currentVersion,
              signature: null,
            };
            await c.query(
              'INSERT INTO offline_actions (device_id, action_id, result) VALUES ($1, $2, $3)',
              [device_id, act.action_id, JSON.stringify(resObj)]
            );
            resultMap.set(act.originalIndex, resObj);
            continue;
          }
        }

        appliedCount++;
        const resolution = act.base_version === currentVersion ? 'appended' : 'rebased_append';
        const resObj = {
          action_id: act.action_id,
          status: 'applied',
          resolution,
          error_code: null,
          processed_order,
          server_version: currentVersion + 1,
          signature: eventSig,
        };
        await c.query(
          'INSERT INTO offline_actions (device_id, action_id, result) VALUES ($1, $2, $3)',
          [device_id, act.action_id, JSON.stringify(resObj)]
        );
        resultMap.set(act.originalIndex, resObj);
      } catch (err) {
        rejectedCount++;
        const resObj = {
          action_id: act.action_id,
          status: 'rejected',
          resolution: 'server_wins',
          error_code: err.code || 'VALIDATION_ERROR',
          processed_order,
          server_version: currentVersion,
          signature: null,
        };
        await c.query(
          'INSERT INTO offline_actions (device_id, action_id, result) VALUES ($1, $2, $3)',
          [device_id, act.action_id, JSON.stringify(resObj)]
        );
        resultMap.set(act.originalIndex, resObj);
      }
    }

    // Return in original request order
    const results = actions.map((_, idx) => resultMap.get(idx));

    return {
      device_id,
      results,
      summary: {
        applied: appliedCount,
        rejected: rejectedCount,
        duplicate: duplicateCount,
      },
    };
  };

  if (clientOrPool.query && clientOrPool.release) {
    return execute(clientOrPool);
  }
  return config.withTx(execute);
}

module.exports = { processOfflineSync };
