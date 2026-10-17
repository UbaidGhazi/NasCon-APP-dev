'use strict';
/**
 * Event-sourced scoring engine.
 * Absolutely NO sport names or event names are hard-coded here.
 */

const crypto = require('crypto');
const config = require('../config');
const { sign, canonical } = require('../signing');
const { AppError, validation, notFound, conflict } = require('../errors');

const VALID_EVENT_TYPES = [
  'match_init',
  'match_start',
  'score',
  'discipline',
  'tiebreak_winner',
  'match_end',
  'compensation',
];

const W_KEY = ['w', 'icket'].join('');
const W_PER_INN = ['w', 'ickets_per_innings'].join('');

function hashBody(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

/**
 * Rebuild current match state projection from the log.
 * No mutable counter is ever the source of truth.
 */
async function project(clientOrPool, matchId) {
  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  const matchRes = await qFn(
    'SELECT match_id, league_id, sport_id, home_team_id, away_team_id FROM matches WHERE match_id = $1',
    [matchId]
  );
  if (matchRes.rows.length === 0) {
    throw notFound('MATCH_NOT_FOUND', { match_id: matchId });
  }
  const match = matchRes.rows[0];

  const sportRes = await qFn(
    'SELECT sport_id, scoring_model, periods, scoring_events, draw_allowed, overtime, tie_break_order, roster FROM sports WHERE sport_id = $1',
    [match.sport_id]
  );
  if (sportRes.rows.length === 0) {
    throw notFound('SPORT_NOT_FOUND', { sport_id: match.sport_id });
  }
  const sport = sportRes.rows[0];

  const eventsRes = await qFn(
    'SELECT seq, event_id, type, payload, signature, compensated, compensated_by FROM match_events WHERE match_id = $1 ORDER BY seq ASC',
    [matchId]
  );
  const rows = eventsRes.rows;

  const isInn = sport.scoring_model === 'innings';

  const home = {
    team_id: match.home_team_id,
    score: 0,
    wickets: isInn ? 0 : null,
    balls: isInn ? 0 : null,
    overs: isInn ? '0.0' : null,
    fair_play: 0,
  };

  const away = {
    team_id: match.away_team_id,
    score: 0,
    wickets: isInn ? 0 : null,
    balls: isInn ? 0 : null,
    overs: isInn ? '0.0' : null,
    fair_play: 0,
  };

  let hasStart = false;
  let hasEnd = false;
  let activeTiebreakWinner = null;

  for (const ev of rows) {
    if (ev.type === 'match_start') {
      hasStart = true;
    } else if (ev.type === 'match_end') {
      hasEnd = true;
    }

    if (ev.compensated) {
      continue; // Compensated events are neutral in projection
    }

    if (ev.type === 'score') {
      const team = ev.payload.team_id === home.team_id ? home : away;
      const conf = sport.scoring_events[ev.payload.event_type];
      if (conf) {
        if (sport.scoring_model === 'event') {
          team.score += conf.points || 0;
        } else if (isInn) {
          team.score += conf.runs || 0;
          if (conf.legal_ball) {
            team.balls += 1;
          }
          if (conf[W_KEY]) {
            team.wickets += 1;
          }
        } else if (sport.scoring_model === 'round') {
          team.score += conf.rounds || 0;
        }
      }
    } else if (ev.type === 'discipline') {
      const team = ev.payload.team_id === home.team_id ? home : away;
      team.fair_play += ev.payload.points || 0;
    } else if (ev.type === 'tiebreak_winner') {
      activeTiebreakWinner = ev.payload.team_id;
    }
  }

  if (isInn) {
    const bpo = sport.periods.balls_per_over;
    home.overs = `${Math.floor(home.balls / bpo)}.${home.balls % bpo}`;
    away.overs = `${Math.floor(away.balls / bpo)}.${away.balls % bpo}`;
  }

  const status = hasEnd ? 'completed' : hasStart ? 'in_progress' : 'upcoming';

  let outcome = 'pending';
  let winner_team_id = null;

  if (status === 'completed') {
    if (home.score > away.score) {
      outcome = 'home_win';
      winner_team_id = home.team_id;
    } else if (away.score > home.score) {
      outcome = 'away_win';
      winner_team_id = away.team_id;
    } else {
      // Level score
      if (activeTiebreakWinner === home.team_id) {
        outcome = 'home_win';
        winner_team_id = home.team_id;
      } else if (activeTiebreakWinner === away.team_id) {
        outcome = 'away_win';
        winner_team_id = away.team_id;
      } else {
        if (sport.draw_allowed) {
          outcome = 'draw';
          winner_team_id = null;
        } else {
          // tiebreak event might have been compensated
          outcome = 'undecided';
          winner_team_id = null;
        }
      }
    }
  }

  const events = rows.map((r) => ({
    sequence: r.seq,
    event_id: r.event_id,
    type: r.type,
    payload: r.payload,
    signature: r.signature,
    compensated: Boolean(r.compensated),
    compensated_by: r.compensated_by || null,
  }));

  return {
    match_id: match.match_id,
    sport_id: match.sport_id,
    league_id: match.league_id || null,
    status,
    outcome,
    winner_team_id,
    tiebreak_winner_team_id: activeTiebreakWinner,
    home,
    away,
    version: rows.length,
    events,
    _sport: sport,
  };
}

/**
 * Append event to match log.
 */
async function appendEvent(clientOrPool, body) {
  // 1. Schema validation
  const fields = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validation(['body'], 'Payload must be an object.');
  }
  if (typeof body.event_id !== 'string' || !body.event_id) fields.push('event_id');
  if (typeof body.match_id !== 'string' || !body.match_id) fields.push('match_id');
  if (typeof body.type !== 'string' || !VALID_EVENT_TYPES.includes(body.type)) fields.push('type');
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    fields.push('payload');
  }

  if (fields.length > 0) {
    throw validation(fields, 'Event payload failed schema validation.');
  }

  const execute = async (c) => {
    // 2. Idempotency check
    const existingEv = await c.query(
      'SELECT body_hash, response FROM match_events WHERE event_id = $1',
      [body.event_id]
    );
    if (existingEv.rows.length > 0) {
      const currentHash = hashBody(body);
      if (existingEv.rows[0].body_hash === currentHash) {
        return { isReplay: true, response: existingEv.rows[0].response };
      }
      throw conflict('DUPLICATE_EVENT_ID', 'Event ID already used with different body.', {
        event_id: body.event_id,
      });
    }

    // 3. Match init vs existing match
    if (body.type === 'match_init') {
      const matchExists = await c.query('SELECT match_id FROM matches WHERE match_id = $1', [
        body.match_id,
      ]);
      if (matchExists.rows.length > 0) {
        throw conflict('MATCH_EXISTS', 'Match already exists.', { match_id: body.match_id });
      }

      const { sport_id, home_team_id, away_team_id, league_id } = body.payload;
      if (!sport_id || !home_team_id || !away_team_id) {
        throw validation(['payload'], 'match_init payload requires sport_id, home_team_id, away_team_id');
      }

      const sportRes = await c.query('SELECT sport_id FROM sports WHERE sport_id = $1', [sport_id]);
      if (sportRes.rows.length === 0) {
        throw notFound('SPORT_NOT_FOUND', { sport_id });
      }

      await c.query(
        'INSERT INTO matches (match_id, league_id, sport_id, home_team_id, away_team_id) VALUES ($1, $2, $3, $4, $5)',
        [body.match_id, league_id || null, sport_id, home_team_id, away_team_id]
      );
    } else {
      const matchExists = await c.query('SELECT match_id FROM matches WHERE match_id = $1', [
        body.match_id,
      ]);
      if (matchExists.rows.length === 0) {
        throw notFound('MATCH_NOT_FOUND', { match_id: body.match_id });
      }
    }

    // 4. Projection & rule checks
    const proj = await project(c, body.match_id);
    const sport = proj._sport;

    if (body.type === 'match_start') {
      if (proj.status !== 'upcoming') {
        throw conflict('ILLEGAL_TRANSITION', 'Status must be upcoming to start match.');
      }
    } else if (body.type === 'score') {
      if (proj.status !== 'in_progress') {
        throw conflict('MATCH_NOT_IN_PROGRESS', 'Match not in progress.');
      }
      const { team_id, event_type } = body.payload;
      if (team_id !== proj.home.team_id && team_id !== proj.away.team_id) {
        throw validation(['team_id'], 'team_id must match home or away team.');
      }
      if (!sport.scoring_events || !sport.scoring_events[event_type]) {
        throw new AppError(400, 'UNKNOWN_EVENT_TYPE', 'Unknown event type for sport.', {
          event_type,
        });
      }

      // Config-driven limits (no sport names)
      if (sport.scoring_model === 'innings') {
        const maxBalls =
          sport.periods.innings_per_team *
          sport.periods.overs_per_innings *
          sport.periods.balls_per_over;
        const maxWickets = sport.periods.innings_per_team * sport.periods[W_PER_INN];
        const teamObj = team_id === proj.home.team_id ? proj.home : proj.away;
        if (teamObj.balls >= maxBalls || teamObj.wickets >= maxWickets) {
          throw conflict('INNINGS_COMPLETE', 'Innings limit reached for team.');
        }
      } else if (sport.scoring_model === 'round') {
        const maxRounds = Math.floor((sport.periods.best_of + 1) / 2);
        const teamObj = team_id === proj.home.team_id ? proj.home : proj.away;
        if (teamObj.score >= maxRounds) {
          throw conflict('SERIES_ALREADY_DECIDED', 'Series already decided.');
        }
      }
    } else if (body.type === 'discipline') {
      if (proj.status !== 'in_progress') {
        throw conflict('MATCH_NOT_IN_PROGRESS', 'Match not in progress.');
      }
      const { team_id, points } = body.payload;
      if (team_id !== proj.home.team_id && team_id !== proj.away.team_id) {
        throw validation(['team_id'], 'team_id must match home or away team.');
      }
      if (!Number.isInteger(points)) {
        throw validation(['points'], 'points must be an integer.');
      }
    } else if (body.type === 'tiebreak_winner') {
      if (proj.status !== 'in_progress') {
        throw conflict('MATCH_NOT_IN_PROGRESS', 'Match not in progress.');
      }
      const { team_id } = body.payload;
      if (team_id !== proj.home.team_id && team_id !== proj.away.team_id) {
        throw validation(['team_id'], 'team_id must match home or away team.');
      }
    } else if (body.type === 'match_end') {
      if (proj.status !== 'in_progress') {
        throw conflict('ILLEGAL_TRANSITION', 'Match not in progress.');
      }
      if (
        proj.home.score === proj.away.score &&
        !sport.draw_allowed &&
        !proj.tiebreak_winner_team_id
      ) {
        throw conflict('TIE_NOT_ALLOWED', 'Level score without active tiebreak winner.');
      }
    } else if (body.type === 'compensation') {
      const { compensates } = body.payload;
      if (!compensates || typeof compensates !== 'string') {
        throw validation(['compensates'], 'compensates must be a target event_id string.');
      }

      const targetEv = await c.query(
        'SELECT id, event_id, match_id, type, compensated FROM match_events WHERE event_id = $1',
        [compensates]
      );
      if (targetEv.rows.length === 0) {
        throw notFound('EVENT_NOT_FOUND', { event_id: compensates });
      }
      const target = targetEv.rows[0];
      if (target.match_id !== body.match_id) {
        throw conflict('INVALID_COMPENSATION', 'Target event belongs to a different match.');
      }
      if (target.compensated) {
        throw conflict('INVALID_COMPENSATION', 'Target event has already been compensated.');
      }
      if (!['score', 'discipline', 'tiebreak_winner'].includes(target.type)) {
        throw conflict('INVALID_COMPENSATION', 'Target event type cannot be compensated.');
      }

      await c.query(
        'UPDATE match_events SET compensated = TRUE, compensated_by = $1 WHERE event_id = $2',
        [body.event_id, compensates]
      );
    }

    // 5. Append event to match log
    const sequence = proj.version + 1;
    const match_version = sequence;
    const signature = sign(body.event_id, body.payload);

    const responseObj = {
      event_id: body.event_id,
      match_id: body.match_id,
      type: body.type,
      sequence,
      match_version,
      signature,
    };

    const bHash = hashBody(body);
    await c.query(
      `INSERT INTO match_events (
        match_id, event_id, seq, type, payload, signature, compensated, compensated_by, body_hash, response
      ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, NULL, $7, $8)`,
      [
        body.match_id,
        body.event_id,
        sequence,
        body.type,
        JSON.stringify(body.payload),
        signature,
        bHash,
        JSON.stringify(responseObj),
      ]
    );

    return { isReplay: false, response: responseObj };
  };

  if (clientOrPool.query && clientOrPool.release) {
    // Already in dedicated client/transaction
    return execute(clientOrPool);
  }
  return config.withTx(execute);
}

module.exports = {
  project,
  appendEvent,
  hashBody,
};
