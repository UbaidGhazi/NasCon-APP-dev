'use strict';

const express = require('express');
const { asyncH } = require('../errors');
const config = require('../config');
const { setupRoster, transfer, getRosterHistory } = require('../domain/roster');

const router = express.Router();

/**
 * POST /audit/v1/roster/setup
 */
router.post(
  '/roster/setup',
  asyncH(async (req, res) => {
    const result = await setupRoster(config, req.body);
    res.status(201).json(result);
  })
);

/**
 * POST /audit/v1/roster/transfer
 */
router.post(
  '/roster/transfer',
  asyncH(async (req, res) => {
    const result = await transfer(config, req.body);
    res.status(result.status).json(result.body);
  })
);

/**
 * GET /audit/v1/roster/history/:player_id
 */
router.get(
  '/roster/history/:player_id',
  asyncH(async (req, res) => {
    const history = await getRosterHistory(config, req.params.player_id, req.query.as_of);
    res.status(200).json(history);
  })
);

module.exports = router;
