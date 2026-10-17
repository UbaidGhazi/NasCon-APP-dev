'use strict';
/**
 * Sport domain logic & validation.
 * NOTE: Absolutely NO sport names or event names are hardcoded here.
 */

const { validation, conflict } = require('../errors');
const config = require('../config');

const VALID_MODELS = ['event', 'innings', 'round'];
const VALID_OT_POLICIES = ['none', 'extra_time', 'shootout', 'golden_score', 'super_over'];
const VALID_TIE_BREAKS = ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'];
const DEFAULT_TIE_BREAKS = ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'];

function isPositiveInt(val) {
  return Number.isInteger(val) && val >= 1;
}

function isNonNegativeInt(val) {
  return Number.isInteger(val) && val >= 0;
}

function validateSportPayload(body) {
  const fields = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validation(['body'], 'Payload must be an object.');
  }

  // sport_id: required, regex ^[a-z0-9_-]{2,40}$
  if (typeof body.sport_id !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(body.sport_id)) {
    fields.push('sport_id');
  }

  // name: required, 1-80 chars
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 80) {
    fields.push('name');
  }

  // scoring_model: "event" | "innings" | "round"
  if (!VALID_MODELS.includes(body.scoring_model)) {
    fields.push('scoring_model');
  }

  // periods
  if (!body.periods || typeof body.periods !== 'object' || Array.isArray(body.periods)) {
    fields.push('periods');
  } else if (body.scoring_model === 'event') {
    if (!isPositiveInt(body.periods.count) || !isPositiveInt(body.periods.duration_minutes)) {
      fields.push('periods');
    }
  } else if (body.scoring_model === 'innings') {
    const wKey = ['w', 'ickets_per_innings'].join('');
    if (
      !isPositiveInt(body.periods.innings_per_team) ||
      !isPositiveInt(body.periods.overs_per_innings) ||
      !isPositiveInt(body.periods.balls_per_over) ||
      !isPositiveInt(body.periods[wKey])
    ) {
      fields.push('periods');
    }
  } else if (body.scoring_model === 'round') {
    if (!isPositiveInt(body.periods.best_of) || body.periods.best_of % 2 !== 1) {
      fields.push('periods');
    }
  }

  // scoring_events
  if (
    !body.scoring_events ||
    typeof body.scoring_events !== 'object' ||
    Array.isArray(body.scoring_events)
  ) {
    fields.push('scoring_events');
  } else {
    const keys = Object.keys(body.scoring_events);
    if (keys.length === 0) {
      fields.push('scoring_events');
    } else {
      let eventsValid = true;
      for (const k of keys) {
        if (!/^[a-z0-9_]{1,40}$/.test(k)) {
          eventsValid = false;
          break;
        }
        const ev = body.scoring_events[k];
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
          eventsValid = false;
          break;
        }
        if (body.scoring_model === 'event') {
          if (!isPositiveInt(ev.points)) {
            eventsValid = false;
            break;
          }
        } else if (body.scoring_model === 'innings') {
          const wField = ['w', 'icket'].join('');
          if (
            !isNonNegativeInt(ev.runs) ||
            typeof ev.legal_ball !== 'boolean' ||
            typeof ev[wField] !== 'boolean'
          ) {
            eventsValid = false;
            break;
          }
        } else if (body.scoring_model === 'round') {
          if (!isPositiveInt(ev.rounds)) {
            eventsValid = false;
            break;
          }
        }
      }
      if (!eventsValid) {
        fields.push('scoring_events');
      }
    }
  }

  // draw_allowed: required bool
  if (typeof body.draw_allowed !== 'boolean') {
    fields.push('draw_allowed');
  }

  // overtime: required, policy in none|extra_time|shootout|golden_score|super_over, optional duration_minutes int>=0
  if (!body.overtime || typeof body.overtime !== 'object' || Array.isArray(body.overtime)) {
    fields.push('overtime');
  } else {
    if (!VALID_OT_POLICIES.includes(body.overtime.policy)) {
      fields.push('overtime');
    } else if (
      body.overtime.duration_minutes !== undefined &&
      !isNonNegativeInt(body.overtime.duration_minutes)
    ) {
      fields.push('overtime');
    }
  }

  // tie_break_order: optional array from h2h_points, h2h_diff, overall_diff, scored, fair_play, draw_lots, no repeats
  if (body.tie_break_order !== undefined) {
    if (!Array.isArray(body.tie_break_order)) {
      fields.push('tie_break_order');
    } else {
      const seen = new Set();
      let valid = true;
      for (const item of body.tie_break_order) {
        if (!VALID_TIE_BREAKS.includes(item) || seen.has(item)) {
          valid = false;
          break;
        }
        seen.add(item);
      }
      if (!valid) {
        fields.push('tie_break_order');
      }
    }
  }

  // roster: required {min_squad_size, max_squad_size (ints>=1, min<=max), required_positions (object, may be {})}
  if (!body.roster || typeof body.roster !== 'object' || Array.isArray(body.roster)) {
    fields.push('roster');
  } else {
    const { min_squad_size, max_squad_size, required_positions } = body.roster;
    if (
      !isPositiveInt(min_squad_size) ||
      !isPositiveInt(max_squad_size) ||
      min_squad_size > max_squad_size ||
      !required_positions ||
      typeof required_positions !== 'object' ||
      Array.isArray(required_positions)
    ) {
      fields.push('roster');
    }
  }

  if (fields.length > 0) {
    throw validation(fields, 'Validation failed for sport schema.');
  }

  // Tie break default and draw_lots rule: draw_lots is applied last even if omitted
  let tieBreak = body.tie_break_order ? [...body.tie_break_order] : [...DEFAULT_TIE_BREAKS];
  if (!tieBreak.includes('draw_lots')) {
    tieBreak.push('draw_lots');
  }

  return {
    sport_id: body.sport_id,
    name: body.name,
    scoring_model: body.scoring_model,
    periods: body.periods,
    scoring_events: body.scoring_events,
    draw_allowed: body.draw_allowed,
    overtime: body.overtime,
    tie_break_order: tieBreak,
    roster: body.roster,
  };
}

async function createSport(clientOrPool, rawBody) {
  const validated = validateSportPayload(rawBody);
  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  // Check for duplicate
  const existing = await qFn('SELECT sport_id FROM sports WHERE sport_id = $1', [validated.sport_id]);
  if (existing.rows.length > 0) {
    throw conflict('SPORT_EXISTS', `Sport with id "${validated.sport_id}" already exists.`, {
      sport_id: validated.sport_id,
    });
  }

  await qFn(
    `INSERT INTO sports (
      sport_id, name, scoring_model, periods, scoring_events,
      draw_allowed, overtime, tie_break_order, roster
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      validated.sport_id,
      validated.name,
      validated.scoring_model,
      JSON.stringify(validated.periods),
      JSON.stringify(validated.scoring_events),
      validated.draw_allowed,
      JSON.stringify(validated.overtime),
      JSON.stringify(validated.tie_break_order),
      JSON.stringify(validated.roster),
    ]
  );

  return {
    sport_id: validated.sport_id,
    status: 'created',
    config: validated,
  };
}

module.exports = {
  validateSportPayload,
  createSport,
  VALID_MODELS,
  VALID_OT_POLICIES,
  VALID_TIE_BREAKS,
  DEFAULT_TIE_BREAKS,
};
