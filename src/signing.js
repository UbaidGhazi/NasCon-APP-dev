'use strict';
/**
 * Section 5.3 — HMAC signature + canonical JSON.
 *
 * This file is the single highest-risk piece of the submission: every event
 * record and every checkout receipt is compared byte-for-byte by the grader.
 *
 * Canonical JSON rules (§5.3):
 *   - object keys sorted ascending by UNICODE CODE POINT (not UTF-16 code unit)
 *   - no whitespace, separators "," and ":"
 *   - UTF-8, non-ASCII NOT escaped  (matches Python ensure_ascii=False)
 *   - integers without a decimal point
 *   - true/false/null lowercase
 *   - array order preserved
 *
 * DO NOT replace this with JSON.stringify(obj) — it does not sort keys.
 * DO NOT replace the comparator with a.localeCompare(b) or the default sort.
 */

const crypto = require('crypto');

/** Compare two strings by Unicode code point (default sort uses UTF-16 units). */
function compareCodePoints(a, b) {
  const A = Array.from(a); // iterates by code point, keeping surrogate pairs whole
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = A[i].codePointAt(0) - B[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

/** Canonical JSON string for any JSON-compatible value. */
function canonical(value) {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in payload');
    // JS has no int/float split: 450000 -> "450000", 2.5 -> "2.5". Matches the spec.
    // Guard against -0 serialising as "0" vs "-0".
    if (Object.is(value, -0)) return '0';
    return String(value);
  }

  // JSON.stringify on a string escapes ", \ and control chars, and leaves
  // non-ASCII characters raw — exactly ensure_ascii=False behaviour.
  if (t === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }

  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort(compareCodePoints);
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }

  throw new TypeError('unsupported type in payload: ' + t);
}

/** The salt, read from the environment ONLY. Never hard-code it, never commit it. */
function salt() {
  const s = process.env.DAY1_SALT;
  if (s === undefined || s === '') throw new Error('DAY1_SALT is not set');
  return s; // UTF-8 bytes, not hex-decoded, not trimmed
}

/**
 * signature = HMAC_SHA256(DAY1_SALT, id + "|" + canonical(payload))
 * @param {string} id        event_id for events, order_id for receipts
 * @param {object} payload   the request payload object / receipt.payload
 * @returns {string} 64 lowercase hex chars
 */
function sign(id, payload) {
  const msg = Buffer.from(id + '|' + canonical(payload), 'utf8');
  return crypto.createHmac('sha256', Buffer.from(salt(), 'utf8')).update(msg).digest('hex');
}

/** §5.10 draw_lots — sort teams ASCENDING by this key; first = best. */
function lotsKey(seed, leagueId, teamId) {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(`${seed}|${leagueId}|${teamId}`, 'utf8'))
    .digest('hex');
}

module.exports = { canonical, sign, lotsKey, compareCodePoints };
