'use strict';

const express = require('express');
const { asyncH, validation } = require('../errors');
const { generateRoundRobin } = require('../domain/fixtures/round_robin');
const { generateSingleElim } = require('../domain/fixtures/single_elim');
const { generateSwiss } = require('../domain/fixtures/swiss');
const { generateDoubleElim } = require('../domain/fixtures/double_elim');

const router = express.Router();

/**
 * POST /audit/v1/fixtures
 * Pure computation — stores nothing.
 */
router.post(
  '/fixtures',
  asyncH(async (req, res) => {
    const { format, teams, params } = req.body || {};

    if (!format || typeof format !== 'string') {
      throw validation(['format'], 'format is required.');
    }
    if (!Array.isArray(teams)) {
      throw validation(['teams'], 'teams must be an array of unique team IDs.');
    }
    if (new Set(teams).size !== teams.length) {
      throw validation(['teams'], 'teams must contain unique strings.');
    }

    let result;
    if (format === 'round_robin') {
      result = generateRoundRobin(teams, params);
    } else if (format === 'single_elim') {
      result = generateSingleElim(teams, params);
    } else if (format === 'swiss') {
      result = generateSwiss(teams, params);
    } else if (format === 'double_elim') {
      result = generateDoubleElim(teams, params);
    } else {
      throw validation(['format'], `Unsupported format: ${format}`);
    }

    res.status(200).json(result);
  })
);

module.exports = router;
