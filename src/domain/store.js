'use strict';
/**
 * Store checkout, atomic inventory reservation, and idempotency.
 */

const crypto = require('crypto');
const config = require('../config');
const { sign, canonical } = require('../signing');
const { AppError, validation, notFound, conflict, paymentDeclined } = require('../errors');
const { generatePdfReceipt } = require('../pdf');

function hashBody(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

/**
 * Perform checkout with atomic reservation and graded error precedence.
 */
async function checkout(clientOrPool, body) {
  // 1. Schema Validation (400 VALIDATION_ERROR)
  const fields = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validation(['body'], 'Payload must be an object.');
  }
  if (!body.order_id || typeof body.order_id !== 'string') fields.push('order_id');
  if (!body.customer_id || typeof body.customer_id !== 'string') fields.push('customer_id');

  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 10) {
    fields.push('items');
  } else {
    const seen = new Set();
    let itemsOk = true;
    for (const it of body.items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        itemsOk = false;
        break;
      }
      if (!it.variant_id || typeof it.variant_id !== 'string') {
        itemsOk = false;
        break;
      }
      if (seen.has(it.variant_id)) {
        itemsOk = false;
        break;
      }
      seen.add(it.variant_id);

      if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 10) {
        itemsOk = false;
        break;
      }
    }
    if (!itemsOk) fields.push('items');
  }

  if (!body.payment || typeof body.payment !== 'object' || typeof body.payment.token !== 'string') {
    fields.push('payment');
  }

  if (fields.length > 0) {
    throw validation(fields, 'Checkout schema validation failed.');
  }

  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  // Check idempotency before variant check
  const existingOrder = await qFn('SELECT body_hash, response FROM orders WHERE order_id = $1', [
    body.order_id,
  ]);
  if (existingOrder.rows.length > 0) {
    const bHash = hashBody(body);
    if (existingOrder.rows[0].body_hash === bHash) {
      return { status: 200, body: existingOrder.rows[0].response };
    }
    throw conflict('DUPLICATE_ORDER_ID', 'Order ID reused with different body.', {
      order_id: body.order_id,
    });
  }

  // 2. Variants exist (404 VARIANT_NOT_FOUND)
  const itemVariantIds = body.items.map((it) => it.variant_id);
  const vRes = await qFn(
    'SELECT variant_id, price_minor, currency FROM variants WHERE variant_id = ANY($1)',
    [itemVariantIds]
  );
  const variantMap = new Map();
  for (const row of vRes.rows) {
    variantMap.set(row.variant_id, row);
  }

  for (const it of body.items) {
    if (!variantMap.has(it.variant_id)) {
      throw notFound('VARIANT_NOT_FOUND', { variant_id: it.variant_id });
    }
  }

  // 3. Discount code check
  let discountPercent = 0;
  if (body.discount_code !== undefined && body.discount_code !== null) {
    if (body.discount_code !== 'WELCOME10') {
      throw new AppError(400, 'INVALID_DISCOUNT_CODE', 'Invalid discount code.');
    }
    discountPercent = 10;
  }

  // Calculate subtotal
  let subtotal_minor = 0;
  const itemsDetail = [];
  for (const it of body.items) {
    const v = variantMap.get(it.variant_id);
    const unitPrice = Number(v.price_minor);
    subtotal_minor += unitPrice * it.quantity;
    itemsDetail.push({
      variant_id: it.variant_id,
      quantity: it.quantity,
      unit_price_minor: unitPrice,
    });
  }

  const discount_minor = Math.floor((subtotal_minor * discountPercent) / 100);
  const total_minor = subtotal_minor - discount_minor;

  // 4. Atomic reservation inside withTx
  // Lock variants in sorted variant_id order to avoid deadlock
  const sortedItems = [...body.items].sort((a, b) => a.variant_id.localeCompare(b.variant_id));

  const executeTx = async (c) => {
    // Lock inventory rows
    for (const it of sortedItems) {
      const invRes = await c.query(
        'SELECT variant_id, stock, reserved FROM inventory WHERE variant_id = $1 FOR UPDATE',
        [it.variant_id]
      );
      if (invRes.rows.length === 0 || invRes.rows[0].stock < it.quantity) {
        throw conflict('OUT_OF_STOCK', 'Insufficient stock for variant.', {
          variant_id: it.variant_id,
        });
      }
    }

    // Reserve stock
    for (const it of sortedItems) {
      await c.query(
        'UPDATE inventory SET stock = stock - $1, reserved = reserved + $1 WHERE variant_id = $2',
        [it.quantity, it.variant_id]
      );
    }

    // 5. Mock gateway handling
    const token = body.payment.token;
    if (token === 'tok_declined') {
      for (const it of sortedItems) {
        await c.query(
          'UPDATE inventory SET stock = stock + $1, reserved = reserved - $1 WHERE variant_id = $2',
          [it.quantity, it.variant_id]
        );
      }
      throw paymentDeclined('PAYMENT_DECLINED', 'Payment was declined.');
    }
    if (token === 'tok_capture_fail') {
      for (const it of sortedItems) {
        await c.query(
          'UPDATE inventory SET stock = stock + $1, reserved = reserved - $1 WHERE variant_id = $2',
          [it.quantity, it.variant_id]
        );
      }
      throw paymentDeclined('PAYMENT_CAPTURE_FAILED', 'Payment capture failed.');
    }
    if (token !== 'tok_success') {
      for (const it of sortedItems) {
        await c.query(
          'UPDATE inventory SET stock = stock + $1, reserved = reserved - $1 WHERE variant_id = $2',
          [it.quantity, it.variant_id]
        );
      }
      throw paymentDeclined('PAYMENT_DECLINED', 'Invalid payment token.');
    }

    // 6. Commit reservation: permanent deduction, reserved back to 0
    for (const it of sortedItems) {
      await c.query('UPDATE inventory SET reserved = reserved - $1 WHERE variant_id = $2', [
        it.quantity,
        it.variant_id,
      ]);
    }

    const authorization_id = `auth_${crypto.randomBytes(8).toString('hex')}`;
    const capture_id = `cap_${crypto.randomBytes(8).toString('hex')}`;
    const paid_at = new Date().toISOString();

    const receiptPayload = {
      order_id: body.order_id,
      customer_id: body.customer_id,
      items: itemsDetail,
      subtotal_minor,
      discount_minor,
      total_minor,
      currency: 'PKR',
      paid_at,
    };

    const signature = sign(body.order_id, receiptPayload);
    const pdf_base64 = generatePdfReceipt({ order_id: body.order_id, total_minor });

    const successResponse = {
      order_id: body.order_id,
      status: 'paid',
      currency: 'PKR',
      items: itemsDetail,
      subtotal_minor,
      discount_minor,
      total_minor,
      payment: {
        authorization_id,
        capture_id,
        state: 'captured',
      },
      receipt: {
        payload: receiptPayload,
        signature,
        pdf_base64,
      },
    };

    const bHash = hashBody(body);
    await c.query(
      'INSERT INTO orders (order_id, customer_id, status, body_hash, response) VALUES ($1, $2, $3, $4, $5)',
      [body.order_id, body.customer_id, 'paid', bHash, JSON.stringify(successResponse)]
    );

    await config.emitDomainEvent('domain:orders', {
      order_id: body.order_id,
      status: 'paid',
      total_minor,
    });

    return { status: 201, body: successResponse };
  };

  if (clientOrPool.query && clientOrPool.release) {
    return executeTx(clientOrPool);
  }
  return config.withTx(executeTx);
}

module.exports = {
  checkout,
  hashBody,
};
