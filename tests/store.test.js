'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { sign } = require('../src/signing');

describe('Store & Concurrency (§5.12)', () => {
  const inventory = new Map();
  const variants = new Map();
  const orders = new Map();

  beforeAll(() => {
    process.env.DAY1_SALT = process.env.DAY1_SALT || 'test-salt';

    variants.set('var-jersey-001-M', {
      variant_id: 'var-jersey-001-M',
      product_id: 'prod-1',
      price_minor: 450000,
      currency: 'PKR',
    });
    variants.set('var-jersey-001-L', {
      variant_id: 'var-jersey-001-L',
      product_id: 'prod-1',
      price_minor: 450000,
      currency: 'PKR',
    });

    inventory.set('var-jersey-001-M', { stock: 1, reserved: 0 });
    inventory.set('var-jersey-001-L', { stock: 5, reserved: 0 });

    const mockQuery = async (sql, params = []) => {
      // variants
      if (sql.includes('FROM variants WHERE variant_id = ANY($1)')) {
        const rows = [];
        for (const vid of params[0]) {
          if (variants.has(vid)) rows.push(variants.get(vid));
        }
        return { rows };
      }
      // inventory select
      if (sql.includes('FROM inventory WHERE variant_id = $1')) {
        const row = inventory.get(params[0]);
        return { rows: row ? [{ variant_id: params[0], stock: row.stock, reserved: row.reserved }] : [] };
      }
      // inventory reserve
      if (sql.includes('UPDATE inventory SET stock = stock - $1, reserved = reserved + $1')) {
        const row = inventory.get(params[1]);
        if (row) {
          row.stock -= params[0];
          row.reserved += params[0];
        }
        return { rowCount: 1 };
      }
      // inventory release
      if (sql.includes('UPDATE inventory SET stock = stock + $1, reserved = reserved - $1')) {
        const row = inventory.get(params[1]);
        if (row) {
          row.stock += params[0];
          row.reserved -= params[0];
        }
        return { rowCount: 1 };
      }
      // inventory commit
      if (sql.includes('UPDATE inventory SET reserved = reserved - $1')) {
        const row = inventory.get(params[1]);
        if (row) {
          row.reserved -= params[0];
        }
        return { rowCount: 1 };
      }
      // orders
      if (sql.includes('FROM orders WHERE order_id = $1')) {
        const row = orders.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('INSERT INTO orders')) {
        orders.set(params[0], {
          order_id: params[0],
          customer_id: params[1],
          status: params[2],
          body_hash: params[3],
          response: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
        });
        return { rowCount: 1 };
      }
      return { rows: [] };
    };

    jest.spyOn(config, 'emitDomainEvent').mockResolvedValue();
    jest.spyOn(config, 'q').mockImplementation(mockQuery);
    jest.spyOn(config, 'withTx').mockImplementation(async (fn) => {
      const client = { query: mockQuery, release: () => {} };
      return fn(client);
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('happy path: checkout creates order with 201, valid PDF, and valid HMAC signature', async () => {
    inventory.set('var-jersey-001-L', { stock: 5, reserved: 0 });

    const reqBody = {
      order_id: 'ord-happy-1',
      customer_id: 'cust-1',
      items: [{ variant_id: 'var-jersey-001-L', quantity: 1 }],
      discount_code: 'WELCOME10',
      payment: { token: 'tok_success' },
    };

    const res = await request(app).post('/audit/v1/checkout').send(reqBody);
    expect(res.status).toBe(201);
    expect(res.body.order_id).toBe('ord-happy-1');
    expect(res.body.subtotal_minor).toBe(450000);
    expect(res.body.discount_minor).toBe(45000);
    expect(res.body.total_minor).toBe(405000);

    // Verify signature
    const sig = sign('ord-happy-1', res.body.receipt.payload);
    expect(res.body.receipt.signature).toBe(sig);

    // Verify PDF
    const pdfBuf = Buffer.from(res.body.receipt.pdf_base64, 'base64');
    expect(pdfBuf.slice(0, 4).toString()).toBe('%PDF');
    const pdfText = pdfBuf.toString('utf8');
    expect(pdfText).toContain('ord-happy-1');
    expect(pdfText).toContain('PKR 4050.00');
  });

  test('idempotency: replay identical order returns 200, different body returns 409', async () => {
    const reqBody = {
      order_id: 'ord-happy-1',
      customer_id: 'cust-1',
      items: [{ variant_id: 'var-jersey-001-L', quantity: 1 }],
      discount_code: 'WELCOME10',
      payment: { token: 'tok_success' },
    };

    // Replay identical -> 200
    const replayRes = await request(app).post('/audit/v1/checkout').send(reqBody);
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.order_id).toBe('ord-happy-1');

    // Replay different body -> 409 DUPLICATE_ORDER_ID
    const diffRes = await request(app).post('/audit/v1/checkout').send({
      ...reqBody,
      customer_id: 'tampered-customer',
    });
    expect(diffRes.status).toBe(409);
    expect(diffRes.body.error.code).toBe('DUPLICATE_ORDER_ID');
  });

  test('payment failure: tok_declined releases reserved stock and returns 402', async () => {
    const initialStock = inventory.get('var-jersey-001-L').stock;

    const res = await request(app).post('/audit/v1/checkout').send({
      order_id: 'ord-fail-1',
      customer_id: 'cust-1',
      items: [{ variant_id: 'var-jersey-001-L', quantity: 1 }],
      payment: { token: 'tok_declined' },
    });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_DECLINED');
    expect(inventory.get('var-jersey-001-L').stock).toBe(initialStock);
    expect(inventory.get('var-jersey-001-L').reserved).toBe(0);
  });

  test('payment failure: tok_capture_fail releases stock and returns 402', async () => {
    const initialStock = inventory.get('var-jersey-001-L').stock;

    const res = await request(app).post('/audit/v1/checkout').send({
      order_id: 'ord-cap-fail-1',
      customer_id: 'cust-1',
      items: [{ variant_id: 'var-jersey-001-L', quantity: 1 }],
      payment: { token: 'tok_capture_fail' },
    });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_CAPTURE_FAILED');
    expect(inventory.get('var-jersey-001-L').stock).toBe(initialStock);
    expect(inventory.get('var-jersey-001-L').reserved).toBe(0);
  });

  test('concurrency: 20 simultaneous checkouts on stock=1 yields exactly 1 success and 19 409s', async () => {
    inventory.set('var-jersey-001-M', { stock: 1, reserved: 0 });

    const requests = [];
    for (let i = 0; i < 20; i++) {
      requests.push(
        request(app).post('/audit/v1/checkout').send({
          order_id: `ord-burst-${i}`,
          customer_id: `cust-${i}`,
          items: [{ variant_id: 'var-jersey-001-M', quantity: 1 }],
          payment: { token: 'tok_success' },
        })
      );
    }

    const responses = await Promise.all(requests);
    const successes = responses.filter((r) => r.status === 201);
    const outOfStock = responses.filter((r) => r.status === 409 && r.body.error.code === 'OUT_OF_STOCK');

    expect(successes.length).toBe(1);
    expect(outOfStock.length).toBe(19);

    const inv = inventory.get('var-jersey-001-M');
    expect(inv.stock).toBe(0);
    expect(inv.reserved).toBe(0);
  });

  describe('Inventory endpoint & validation error precedence', () => {
    test('GET /audit/v1/inventory/:variant_id returns 200 with stock and reserved', async () => {
      const res = await request(app).get('/audit/v1/inventory/var-jersey-001-L');
      expect(res.status).toBe(200);
      expect(res.body.variant_id).toBe('var-jersey-001-L');
      expect(res.body.stock).toBe(5);
      expect(res.body.reserved).toBe(0);
    });

    test('GET /audit/v1/inventory/:variant_id returns 404 for unknown variant', async () => {
      const res = await request(app).get('/audit/v1/inventory/var-unknown');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
    });

    test('POST /audit/v1/checkout validates schema (400) before DB lookups', async () => {
      const res = await request(app).post('/audit/v1/checkout').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields).toContain('order_id');
      expect(res.body.error.details.fields).toContain('customer_id');
      expect(res.body.error.details.fields).toContain('items');
      expect(res.body.error.details.fields).toContain('payment');
    });

    test('POST /audit/v1/checkout validates items array requirements', async () => {
      const res = await request(app).post('/audit/v1/checkout').send({
        order_id: 'ord-bad-items',
        customer_id: 'cust-1',
        items: [{ variant_id: 'var-1', quantity: 999 }], // quantity > 10
        payment: { token: 'tok_success' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toContain('items');
    });

    test('POST /audit/v1/checkout returns 404 for unknown variant', async () => {
      const res = await request(app).post('/audit/v1/checkout').send({
        order_id: 'ord-unknown-var',
        customer_id: 'cust-1',
        items: [{ variant_id: 'var-ghost', quantity: 1 }],
        payment: { token: 'tok_success' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
    });

    test('POST /audit/v1/checkout returns 400 for invalid discount code', async () => {
      const res = await request(app).post('/audit/v1/checkout').send({
        order_id: 'ord-bad-discount',
        customer_id: 'cust-1',
        items: [{ variant_id: 'var-jersey-001-L', quantity: 1 }],
        discount_code: 'FAKE50',
        payment: { token: 'tok_success' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DISCOUNT_CODE');
    });

    test('POST /audit/v1/checkout returns 402 for unrecognized payment token', async () => {
      const res = await request(app).post('/audit/v1/checkout').send({
        order_id: 'ord-bad-tok',
        customer_id: 'cust-1',
        items: [{ variant_id: 'var-jersey-001-L', quantity: 1 }],
        payment: { token: 'tok_random_bad' },
      });
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PAYMENT_DECLINED');
    });
  });
});
