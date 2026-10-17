'use strict';

const express = require('express');
const { asyncH } = require('../errors');
const config = require('../config');
const { createSport } = require('../domain/sports');

const router = express.Router();

/**
 * POST /audit/v1/sports
 * Defines a new sport usable immediately with no restart and no code changes.
 */
router.post(
  '/sports',
  asyncH(async (req, res) => {
    const result = await createSport(config, req.body);
    res.status(201).json(result);
  })
);

module.exports = router;
