'use strict';

const express = require('express');
const { asyncH } = require('../errors');
const config = require('../config');
const { computeStandings } = require('../domain/standings');

const router = express.Router();

/**
 * GET /audit/v1/standings/:league_id
 * Recomputed from scratch from event logs on every call.
 */
router.get(
  '/standings/:league_id',
  asyncH(async (req, res) => {
    const standings = await computeStandings(config, req.params.league_id);
    res.status(200).json(standings);
  })
);

module.exports = router;
