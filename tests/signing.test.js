'use strict';
/**
 * Appendix A reference vectors. If these two fail, nothing else matters —
 * every signed vector in the scoring and store areas will fail with them.
 * Run this FIRST, before writing any route.
 */

const { canonical, sign, lotsKey } = require('../src/signing');

describe('canonical JSON (§5.3)', () => {
  test('sorts object keys ascending', () => {
    expect(canonical({ team_id: 't1', event_type: 'goal' }))
      .toBe('{"event_type":"goal","team_id":"t1"}');
  });

  test('no whitespace, lowercase literals, array order preserved', () => {
    expect(canonical({ b: [3, 1, 2], a: true, c: null, d: false }))
      .toBe('{"a":true,"b":[3,1,2],"c":null,"d":false}');
  });

  test('integers carry no decimal point', () => {
    expect(canonical({ total_minor: 450000 })).toBe('{"total_minor":450000}');
  });

  test('non-ASCII is not escaped', () => {
    expect(canonical({ name: 'Ali Khán' })).toBe('{"name":"Ali Khán"}');
  });

  test('nested objects are sorted recursively', () => {
    expect(canonical({ z: { b: 1, a: 2 }, a: 3 })).toBe('{"a":3,"z":{"a":2,"b":1}}');
  });
});

describe('Appendix A — test vector 1 (signature)', () => {
  const OLD = process.env.DAY1_SALT;
  beforeAll(() => { process.env.DAY1_SALT = 'demo-salt'; });
  afterAll(() => { process.env.DAY1_SALT = OLD; });

  test('matches the published signature exactly', () => {
    const sig = sign('evt-1', { team_id: 't1', event_type: 'goal' });
    expect(sig).toBe('972a8b558690b19121cc5bea84978f85e8eb15a3735018db36616bab1d7ec501');
  });

  test('output is 64 lowercase hex chars', () => {
    expect(sign('evt-1', { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Appendix A — test vector 2 (drawing of lots)', () => {
  test('seed 42, league lg-1', () => {
    expect(lotsKey(42, 'lg-1', 't1'))
      .toBe('0613316991ce0ac31e88d6003e3ff4d5e21bb072ac5f81b42c0cdc6598453293');
    expect(lotsKey(42, 'lg-1', 't2'))
      .toBe('e3e3a14e22727f936e1f288cf5d02a8a9362b1da13c5432725fc10b2c7955dd9');
    expect(lotsKey(42, 'lg-1', 't3'))
      .toBe('c8f28e3c2f1eb6c4f636b4f57050e3362a2b39c07fda9b61742a26dd20397028');
  });

  test('ascending key order puts t1 first, then t3, then t2', () => {
    const order = ['t1', 't2', 't3']
      .map((t) => [t, lotsKey(42, 'lg-1', t)])
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([t]) => t);
    expect(order).toEqual(['t1', 't3', 't2']);
  });
});
