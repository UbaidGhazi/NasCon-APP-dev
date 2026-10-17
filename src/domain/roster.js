'use strict';
/**
 * Roster domain logic, transfers, loans, and audit trails.
 */

const crypto = require('crypto');
const config = require('../config');
const { canonical } = require('../signing');
const { validation, notFound, conflict } = require('../errors');

function hashBody(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

/**
 * POST /audit/v1/roster/setup
 */
async function setupRoster(clientOrPool, body) {
  const { league, squads, players, matches_in_progress } = body || {};
  if (!league || !league.league_id) {
    throw validation(['league'], 'league configuration is required.');
  }

  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  const execute = async (c) => {
    const leagueId = league.league_id;

    // Fetch sport for defaults if needed
    let defaultMaxSize = 25;
    let defaultReqPos = {};
    if (league.sport_id) {
      const sRes = await c.query(
        'SELECT roster FROM sports WHERE sport_id = $1',
        [league.sport_id]
      );
      if (sRes.rows.length > 0) {
        const rConf = sRes.rows[0].roster;
        defaultMaxSize = rConf.max_squad_size || defaultMaxSize;
        defaultReqPos = rConf.required_positions || defaultReqPos;
      }
    }

    const maxSize = league.max_squad_size || defaultMaxSize;
    const reqPos = league.required_positions !== undefined ? league.required_positions : defaultReqPos;

    // Reset this league's roster data
    await c.query('DELETE FROM matches_in_progress WHERE league_id = $1', [leagueId]);
    await c.query('DELETE FROM roster_audit WHERE league_id = $1', [leagueId]);
    await c.query('DELETE FROM registrations WHERE league_id = $1', [leagueId]);
    await c.query('DELETE FROM squads WHERE league_id = $1', [leagueId]);

    // Upsert league record
    await c.query(
      `INSERT INTO leagues (league_id, tenant_id, sport_id, transfer_window, max_squad_size, required_positions)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (league_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         sport_id = COALESCE(EXCLUDED.sport_id, leagues.sport_id),
         transfer_window = EXCLUDED.transfer_window,
         max_squad_size = EXCLUDED.max_squad_size,
         required_positions = EXCLUDED.required_positions`,
      [
        leagueId,
        league.tenant_id || null,
        league.sport_id || null,
        JSON.stringify(league.transfer_window || null),
        maxSize,
        JSON.stringify(reqPos),
      ]
    );

    // Insert squads
    const squadCounts = {};
    for (const sq of squads || []) {
      squadCounts[sq.squad_id] = 0;
      await c.query(
        `INSERT INTO squads (squad_id, club_id, tenant_id, league_id, name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (squad_id) DO UPDATE SET
           club_id = EXCLUDED.club_id,
           tenant_id = EXCLUDED.tenant_id,
           league_id = EXCLUDED.league_id,
           name = EXCLUDED.name`,
        [sq.squad_id, sq.club_id, sq.tenant_id, leagueId, sq.name]
      );
    }

    // Insert players and registrations
    for (const pl of players || []) {
      await c.query(
        `INSERT INTO players (player_id, name, position, club_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (player_id) DO UPDATE SET
           name = EXCLUDED.name,
           position = EXCLUDED.position,
           club_id = COALESCE(EXCLUDED.club_id, players.club_id)`,
        [pl.player_id, pl.name, pl.position, pl.club_id || null]
      );

      if (pl.squad_id) {
        if (squadCounts[pl.squad_id] !== undefined) {
          squadCounts[pl.squad_id]++;
        }
        await c.query(
          `INSERT INTO registrations (player_id, league_id, squad_id, parent_squad_id, registration_type, role, state, active)
           VALUES ($1, $2, $3, NULL, 'initial', $4, 'active', TRUE)`,
          [pl.player_id, leagueId, pl.squad_id, pl.role || 'substitute']
        );
      }
    }

    // Insert matches in progress
    for (const mip of matches_in_progress || []) {
      await c.query(
        `INSERT INTO matches_in_progress (league_id, match_id, home_squad_id, away_squad_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (league_id, match_id) DO NOTHING`,
        [leagueId, mip.match_id, mip.home_squad_id, mip.away_squad_id]
      );
    }

    return {
      league_id: leagueId,
      status: 'configured',
      squad_counts: squadCounts,
    };
  };

  if (clientOrPool.query && clientOrPool.release) {
    return execute(clientOrPool);
  }
  return config.withTx(execute);
}

/**
 * POST /audit/v1/roster/transfer
 * The 8 checks run in exact order. First failure returns.
 */
async function transfer(clientOrPool, body) {
  // 1. Schema, dates, loan_end_date > effective_date, to_squad_id present unless release (400)
  const fields = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validation(['body'], 'Payload must be an object.');
  }
  if (!body.request_id || typeof body.request_id !== 'string') fields.push('request_id');
  if (!body.league_id || typeof body.league_id !== 'string') fields.push('league_id');
  if (!body.player_id || typeof body.player_id !== 'string') fields.push('player_id');
  if (!['transfer', 'loan', 'release'].includes(body.type)) fields.push('type');
  if (!body.from_squad_id || typeof body.from_squad_id !== 'string') fields.push('from_squad_id');
  if (body.type !== 'release') {
    if (!body.to_squad_id || typeof body.to_squad_id !== 'string') fields.push('to_squad_id');
  }
  if (!body.effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.effective_date)) {
    fields.push('effective_date');
  }
  if (body.type === 'loan') {
    if (!body.loan_end_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.loan_end_date)) {
      fields.push('loan_end_date');
    } else if (body.loan_end_date <= body.effective_date) {
      fields.push('loan_end_date');
    }
  }

  if (fields.length > 0) {
    throw validation(fields, 'Transfer schema validation failed.');
  }

  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  // Idempotency check by request_id
  const existingReq = await qFn(
    'SELECT body_hash, response FROM roster_requests WHERE request_id = $1',
    [body.request_id]
  );
  if (existingReq.rows.length > 0) {
    const bHash = hashBody(body);
    if (existingReq.rows[0].body_hash === bHash) {
      return { status: 200, body: existingReq.rows[0].response };
    }
    throw conflict('DUPLICATE_REQUEST_ID', 'Request ID reused with different body.');
  }

  const execute = async (c) => {
    // 2. League / player / squads exist (404)
    const lRes = await c.query(
      'SELECT league_id, tenant_id, transfer_window, max_squad_size, required_positions FROM leagues WHERE league_id = $1',
      [body.league_id]
    );
    if (lRes.rows.length === 0) {
      throw notFound('LEAGUE_NOT_FOUND', { league_id: body.league_id });
    }
    const league = lRes.rows[0];

    const pRes = await c.query('SELECT player_id, name, position FROM players WHERE player_id = $1', [
      body.player_id,
    ]);
    if (pRes.rows.length === 0) {
      throw notFound('PLAYER_NOT_FOUND', { player_id: body.player_id });
    }
    const player = pRes.rows[0];

    const fromRes = await c.query('SELECT squad_id, tenant_id FROM squads WHERE squad_id = $1', [
      body.from_squad_id,
    ]);
    if (fromRes.rows.length === 0) {
      throw notFound('SQUAD_NOT_FOUND', { squad_id: body.from_squad_id });
    }
    const fromSquad = fromRes.rows[0];

    let toSquad = null;
    if (body.type !== 'release') {
      const toRes = await c.query('SELECT squad_id, tenant_id FROM squads WHERE squad_id = $1', [
        body.to_squad_id,
      ]);
      if (toRes.rows.length === 0) {
        throw notFound('SQUAD_NOT_FOUND', { squad_id: body.to_squad_id });
      }
      toSquad = toRes.rows[0];
    }

    // 3. Both squads belong to the league's tenant (409 CROSS_TENANT_TRANSFER)
    if (fromSquad.tenant_id !== league.tenant_id) {
      throw conflict('CROSS_TENANT_TRANSFER', 'From squad does not belong to league tenant.');
    }
    if (toSquad && toSquad.tenant_id !== league.tenant_id) {
      throw conflict('CROSS_TENANT_TRANSFER', 'To squad does not belong to league tenant.');
    }

    // 4. Player's current squad in this league == from_squad_id (409 NOT_IN_SQUAD)
    const regRes = await c.query(
      'SELECT id, squad_id, parent_squad_id, registration_type, role, active FROM registrations WHERE player_id = $1 AND league_id = $2 AND active = TRUE',
      [body.player_id, body.league_id]
    );
    if (regRes.rows.length === 0 || regRes.rows[0].squad_id !== body.from_squad_id) {
      throw conflict('NOT_IN_SQUAD', 'Player is not in specified from_squad.');
    }
    const currentReg = regRes.rows[0];

    // 5. transfer/loan: effective_date inside window (inclusive). Release is allowed on any date (409 TRANSFER_WINDOW_CLOSED)
    if (body.type !== 'release') {
      const window = league.transfer_window;
      if (window && window.open && window.close) {
        if (body.effective_date < window.open || body.effective_date > window.close) {
          throw conflict('TRANSFER_WINDOW_CLOSED', 'Effective date is outside transfer window.');
        }
      }
    }

    // 6. Player is not currently on loan (409 PLAYER_ON_LOAN)
    if (currentReg.registration_type === 'loan') {
      throw conflict('PLAYER_ON_LOAN', 'Player is currently on loan.');
    }

    // 7. transfer/loan: destination count + 1 <= max_squad_size (409 SQUAD_FULL)
    if (body.type !== 'release') {
      const destCountRes = await c.query(
        'SELECT count(*) FROM registrations WHERE league_id = $1 AND squad_id = $2 AND active = TRUE',
        [body.league_id, body.to_squad_id]
      );
      const destCount = Number(destCountRes.rows[0].count);
      const maxSize = league.max_squad_size || 25;
      if (destCount + 1 > maxSize) {
        throw conflict('SQUAD_FULL', 'Destination squad is full.');
      }
    }

    // 8. After the move the FROM squad still has >= required count for player's position (409 MIN_POSITION_VIOLATION)
    const reqPositions = league.required_positions || {};
    const playerPos = player.position;
    if (playerPos && reqPositions[playerPos] !== undefined) {
      const posCountRes = await c.query(
        `SELECT count(*) FROM registrations r
         JOIN players p ON r.player_id = p.player_id
         WHERE r.league_id = $1 AND r.squad_id = $2 AND r.active = TRUE AND p.position = $3`,
        [body.league_id, body.from_squad_id, playerPos]
      );
      const currentPosCount = Number(posCountRes.rows[0].count);
      const minRequired = reqPositions[playerPos];
      if (currentPosCount - 1 < minRequired) {
        throw conflict('MIN_POSITION_VIOLATION', `Moving player violates position requirement for ${playerPos}.`);
      }
    }

    // Check if squad is in matches_in_progress
    const matchRes = await c.query(
      'SELECT match_id FROM matches_in_progress WHERE league_id = $1 AND (home_squad_id = $2 OR away_squad_id = $2)',
      [body.league_id, body.from_squad_id]
    );
    const inProgressMatch = matchRes.rows.length > 0 ? matchRes.rows[0].match_id : null;

    const state = inProgressMatch ? 'deferred_until_match_end' : 'active';
    const blocking_match_id = inProgressMatch;

    // Apply Effects
    let newReg = null;
    if (body.type === 'release') {
      await c.query(
        'UPDATE registrations SET active = FALSE WHERE id = $1',
        [currentReg.id]
      );
    } else if (body.type === 'transfer') {
      await c.query(
        'UPDATE registrations SET active = FALSE WHERE id = $1',
        [currentReg.id]
      );
      const insRes = await c.query(
        `INSERT INTO registrations (
          player_id, league_id, squad_id, parent_squad_id, registration_type,
          start_date, role, state, blocking_match_id, active
        ) VALUES ($1, $2, $3, NULL, 'transfer', $4, 'substitute', $5, $6, TRUE)
        RETURNING *`,
        [body.player_id, body.league_id, body.to_squad_id, body.effective_date, state, blocking_match_id]
      );
      newReg = insRes.rows[0];
    } else if (body.type === 'loan') {
      await c.query(
        'UPDATE registrations SET active = FALSE WHERE id = $1',
        [currentReg.id]
      );
      const insRes = await c.query(
        `INSERT INTO registrations (
          player_id, league_id, squad_id, parent_squad_id, registration_type,
          start_date, loan_end_date, role, state, blocking_match_id, active
        ) VALUES ($1, $2, $3, $4, 'loan', $5, $6, 'substitute', $7, $8, TRUE)
        RETURNING *`,
        [
          body.player_id,
          body.league_id,
          body.to_squad_id,
          body.from_squad_id,
          body.effective_date,
          body.loan_end_date,
          state,
          blocking_match_id,
        ]
      );
      newReg = insRes.rows[0];
    }

    const audit_id = `aud_${crypto.randomBytes(8).toString('hex')}`;
    const when_ts = new Date().toISOString();

    await c.query(
      `INSERT INTO roster_audit (
        audit_id, action, player_id, league_id, from_squad_id, to_squad_id,
        effective_date, state, who, when_ts, why
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        audit_id,
        body.type,
        body.player_id,
        body.league_id,
        body.from_squad_id,
        body.to_squad_id || null,
        body.effective_date,
        state,
        body.requested_by || 'admin',
        when_ts,
        body.reason || null,
      ]
    );

    const audit_entry = {
      audit_id,
      action: body.type,
      player_id: body.player_id,
      league_id: body.league_id,
      from_squad_id: body.from_squad_id,
      to_squad_id: body.to_squad_id || null,
      effective_date: body.effective_date,
      state,
      who: body.requested_by || 'admin',
      when: when_ts,
      why: body.reason || null,
    };

    function safeDateStr(d) {
      if (!d) return null;
      if (typeof d === 'string') return d.slice(0, 10);
      try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return String(d); }
    }

    const registrationObj = newReg
      ? {
          player_id: newReg.player_id,
          league_id: newReg.league_id,
          squad_id: newReg.squad_id,
          parent_squad_id: newReg.parent_squad_id || null,
          registration_type: newReg.registration_type,
          start_date: safeDateStr(newReg.start_date) || body.effective_date,
          loan_end_date: safeDateStr(newReg.loan_end_date),
          role: newReg.role,
        }
      : null;

    const responseBody = {
      request_id: body.request_id,
      status: 'accepted',
      state,
      blocking_match_id,
      registration: registrationObj,
      audit_entry,
    };

    const bHash = hashBody(body);
    await c.query(
      'INSERT INTO roster_requests (request_id, body_hash, response) VALUES ($1, $2, $3)',
      [body.request_id, bHash, JSON.stringify(responseBody)]
    );

    return { status: 201, body: responseBody };
  };

  if (clientOrPool.query && clientOrPool.release) {
    return execute(clientOrPool);
  }
  return config.withTx(execute);
}

/**
 * GET /audit/v1/roster/history/:player_id?as_of=YYYY-MM-DD
 */
async function getRosterHistory(clientOrPool, playerId, asOfParam) {
  const as_of = asOfParam || new Date().toISOString().split('T')[0];
  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  // Check player exists
  const pRes = await qFn('SELECT player_id FROM players WHERE player_id = $1', [playerId]);
  if (pRes.rows.length === 0) {
    throw notFound('PLAYER_NOT_FOUND', { player_id: playerId });
  }

  const execute = async (c) => {
    // Check if player has an active loan registration that has expired as of `as_of`
    const loanRegRes = await c.query(
      `SELECT id, league_id, squad_id, parent_squad_id, loan_end_date
       FROM registrations
       WHERE player_id = $1 AND registration_type = 'loan' AND active = TRUE`,
      [playerId]
    );

    if (loanRegRes.rows.length > 0) {
      const reg = loanRegRes.rows[0];
      const loanEnd = typeof reg.loan_end_date === 'string'
        ? reg.loan_end_date.slice(0, 10)
        : new Date(reg.loan_end_date).toISOString().split('T')[0];
      if (as_of > loanEnd) {
        // Loan expired -> check if loan_return already logged
        const existingReturn = await c.query(
          `SELECT audit_id FROM roster_audit
           WHERE player_id = $1 AND league_id = $2 AND action = 'loan_return' AND from_squad_id = $3`,
          [playerId, reg.league_id, reg.squad_id]
        );

        if (existingReturn.rows.length === 0) {
          // Calculate the day after loan_end_date
          const nextDay = new Date(loanEnd + 'T00:00:00Z');
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          const effectiveDate = nextDay.toISOString().split('T')[0];

          const audit_id = `aud_${crypto.randomBytes(8).toString('hex')}`;
          const nowTs = new Date().toISOString();

          await c.query(
            `INSERT INTO roster_audit (
              audit_id, action, player_id, league_id, from_squad_id, to_squad_id,
              effective_date, state, who, when_ts, why
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              audit_id,
              'loan_return',
              playerId,
              reg.league_id,
              reg.squad_id,
              reg.parent_squad_id,
              effectiveDate,
              'active',
              'system',
              nowTs,
              'Loan expired',
            ]
          );

          // Update registration back to parent squad
          await c.query(
            `UPDATE registrations SET
               squad_id = parent_squad_id,
               parent_squad_id = NULL,
               registration_type = 'transfer',
               loan_end_date = NULL,
               role = 'substitute'
             WHERE id = $1`,
            [reg.id]
          );
        }
      }
    }

    // Fetch latest active registration
    const curRegRes = await c.query(
      `SELECT league_id, squad_id, parent_squad_id
       FROM registrations
       WHERE player_id = $1 AND active = TRUE
       ORDER BY id DESC LIMIT 1`,
      [playerId]
    );

    const curReg = curRegRes.rows.length > 0 ? curRegRes.rows[0] : null;

    // Fetch audit entries oldest first
    const auditRes = await c.query(
      `SELECT audit_id, action, player_id, league_id, from_squad_id, to_squad_id,
              effective_date, state, who, when_ts as when, why
       FROM roster_audit
       WHERE player_id = $1
       ORDER BY seq ASC`,
      [playerId]
    );

    const history = auditRes.rows.map((r) => ({
      audit_id: r.audit_id,
      action: r.action,
      player_id: r.player_id,
      league_id: r.league_id,
      from_squad_id: r.from_squad_id,
      to_squad_id: r.to_squad_id,
      effective_date: r.effective_date ? new Date(r.effective_date).toISOString().split('T')[0] : null,
      state: r.state,
      who: r.who,
      when: r.when,
      why: r.why,
    }));

    return {
      player_id: playerId,
      as_of,
      league_id: curReg ? curReg.league_id : (history[0] ? history[0].league_id : null),
      current_squad_id: curReg ? curReg.squad_id : null,
      parent_squad_id: curReg ? curReg.parent_squad_id : null,
      history,
    };
  };

  if (clientOrPool.query && clientOrPool.release) {
    return execute(clientOrPool);
  }
  return config.withTx(execute);
}

module.exports = {
  setupRoster,
  transfer,
  getRosterHistory,
  hashBody,
};
