'use strict';

const express = require('express');
const { asyncH, validation, notFound, conflict } = require('../errors');
const config = require('../config');

const router = express.Router();

/**
 * POST /audit/v1/leagues
 */
router.post(
  '/leagues',
  asyncH(async (req, res) => {
    const body = req.body || {};
    const {
      league_id,
      sport_id,
      teams,
      fixtures,
      points,
      tie_break_order,
      qualification,
      lots_seed,
    } = body;

    // 1. Schema Validation
    const fields = [];
    if (!league_id || typeof league_id !== 'string') fields.push('league_id');
    if (!sport_id || typeof sport_id !== 'string') fields.push('sport_id');
    if (!Array.isArray(teams) || teams.length < 2 || teams.length > 40) fields.push('teams');
    if (new Set(teams || []).size !== (teams || []).length) fields.push('teams');

    if (!fixtures || !Array.isArray(fixtures)) fields.push('fixtures');
    if (!qualification || !Number.isInteger(qualification.spots) || qualification.spots < 1) {
      fields.push('qualification.spots');
    }

    if (fields.length > 0) {
      throw validation(fields, 'Invalid league registration payload.');
    }

    if (qualification.spots > teams.length) {
      throw validation(['qualification.spots'], 'Qualification spots cannot exceed team count.');
    }

    const teamSet = new Set(teams);
    const fixtureMatchIds = new Set();
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      if (!f.match_id || typeof f.match_id !== 'string') {
        throw validation([`fixtures[${i}].match_id`]);
      }
      if (fixtureMatchIds.has(f.match_id)) {
        throw conflict('MATCH_EXISTS', `Duplicate match_id in fixtures: ${f.match_id}`);
      }
      fixtureMatchIds.add(f.match_id);

      if (!teamSet.has(f.home) || !teamSet.has(f.away) || f.home === f.away) {
        throw validation([`fixtures[${i}]`], 'Fixture teams must belong to teams array and home != away.');
      }
    }

    const result = await config.withTx(async (c) => {
      // Check sport exists
      const sportRes = await c.query(
        'SELECT sport_id, tie_break_order FROM sports WHERE sport_id = $1',
        [sport_id]
      );
      if (sportRes.rows.length === 0) {
        throw notFound('SPORT_NOT_FOUND', { sport_id });
      }
      const sport = sportRes.rows[0];

      // Check league exists
      const leagueRes = await c.query('SELECT league_id FROM leagues WHERE league_id = $1', [
        league_id,
      ]);
      if (leagueRes.rows.length > 0) {
        throw conflict('LEAGUE_EXISTS', `League with id "${league_id}" already exists.`);
      }

      // Check fixture match_id reuse in DB
      for (const f of fixtures) {
        const mRes = await c.query('SELECT match_id FROM matches WHERE match_id = $1', [
          f.match_id,
        ]);
        if (mRes.rows.length > 0) {
          throw conflict('MATCH_EXISTS', `Match with id "${f.match_id}" already exists.`);
        }
      }

      // Lots seed default from app_state if not provided
      let finalSeed = lots_seed;
      if (finalSeed === undefined) {
        const seedRes = await c.query("SELECT v FROM app_state WHERE k = 'seed'");
        finalSeed = seedRes.rows.length > 0 ? Number(seedRes.rows[0].v) : 42;
      }

      const finalPoints = {
        win: (points && points.win !== undefined) ? points.win : 3,
        draw: (points && points.draw !== undefined) ? points.draw : 1,
        loss: (points && points.loss !== undefined) ? points.loss : 0,
      };

      const finalTieBreak = tie_break_order || sport.tie_break_order;

      // Insert league
      await c.query(
        `INSERT INTO leagues (league_id, sport_id, points, tie_break_order, qualification_spots, lots_seed)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          league_id,
          sport_id,
          JSON.stringify(finalPoints),
          JSON.stringify(finalTieBreak),
          qualification.spots,
          finalSeed,
        ]
      );

      // Insert league_teams
      for (let i = 0; i < teams.length; i++) {
        await c.query(
          'INSERT INTO league_teams (league_id, team_id, seed_idx) VALUES ($1, $2, $3)',
          [league_id, teams[i], i]
        );
      }

      // Insert matches as upcoming streams
      for (const f of fixtures) {
        await c.query(
          'INSERT INTO matches (match_id, league_id, sport_id, home_team_id, away_team_id) VALUES ($1, $2, $3, $4, $5)',
          [f.match_id, league_id, sport_id, f.home, f.away]
        );
      }

      return {
        league_id,
        status: 'created',
        team_count: teams.length,
        fixture_count: fixtures.length,
      };
    });

    res.status(201).json(result);
  })
);

module.exports = router;
