'use strict';

const express = require('express');
const { asyncH } = require('../errors');
const config = require('../config');
const { appendEvent, project } = require('../domain/scoring');

const router = express.Router();

/**
 * POST /audit/v1/events
 * Appends event to the match event stream with idempotency and business rules.
 */
router.post(
  '/events',
  asyncH(async (req, res) => {
    const result = await appendEvent(config, req.body);
    if (result.isReplay) {
      return res.status(200).json(result.response);
    }
    return res.status(201).json(result.response);
  })
);

/**
 * GET /audit/v1/score/:match_id
 * Rebuilt from the log on every call.
 */
router.get(
  '/score/:match_id',
  asyncH(async (req, res) => {
    const proj = await project(config, req.params.match_id);
    const { _sport, ...scoreBody } = proj;
    res.status(200).json(scoreBody);
  })
);

module.exports = router;
