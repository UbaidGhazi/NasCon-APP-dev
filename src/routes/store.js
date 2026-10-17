'use strict';

const express = require('express');
const { asyncH, notFound } = require('../errors');
const config = require('../config');
const { checkout } = require('../domain/store');

const router = express.Router();

/**
 * POST /audit/v1/checkout
 */
router.post(
  '/checkout',
  asyncH(async (req, res) => {
    const out = await checkout(config, req.body);
    res.status(out.status).json(out.body);
  })
);

/**
 * GET /audit/v1/inventory/:variant_id
 */
router.get(
  '/inventory/:variant_id',
  asyncH(async (req, res) => {
    const { variant_id } = req.params;
    const r = await config.q(
      'SELECT variant_id, stock, reserved FROM inventory WHERE variant_id = $1',
      [variant_id]
    );
    if (r.rows.length === 0) {
      throw notFound('VARIANT_NOT_FOUND', { variant_id });
    }
    const row = r.rows[0];
    res.status(200).json({
      variant_id: row.variant_id,
      stock: Number(row.stock),
      reserved: Number(row.reserved),
    });
  })
);

module.exports = router;
