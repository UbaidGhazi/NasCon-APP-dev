'use strict';

const express = require('express');
const { asyncH } = require('../errors');
const config = require('../config');
const { processOfflineSync } = require('../domain/offline');

const router = express.Router();

/**
 * POST /audit/v1/offline-sync
 * Process queued actions atomically and deterministically.
 */
router.post(
  '/offline-sync',
  asyncH(async (req, res) => {
    const result = await processOfflineSync(config, req.body);
    res.status(200).json(result);
  })
);

module.exports = router;
