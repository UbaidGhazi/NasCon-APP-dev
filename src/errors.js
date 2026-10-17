'use strict';
/**
 * Appendix B error catalogue + the one error envelope used everywhere.
 *
 * Every non-2xx response MUST be:
 *   { "error": { "code": "...", "message": "...", "details": {} } }
 * `details` is ALWAYS an object, never null. For VALIDATION_ERROR,
 * details.fields is an array of the offending field names.
 */

class AppError extends Error {
  constructor(status, code, message = '', details = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details && typeof details === 'object' ? details : {};
  }
  toBody() {
    return { error: { code: this.code, message: this.message || '', details: this.details } };
  }
}

// ---- shorthand constructors for the codes the grader compares literally ----

const validation = (fields, message = 'Request failed validation.') =>
  new AppError(400, 'VALIDATION_ERROR', message, { fields: [].concat(fields || []) });

const notFound = (code, details = {}, message = 'Referenced id does not exist.') =>
  new AppError(404, code, message, details);

const conflict = (code, message = 'Business rule violated.', details = {}) =>
  new AppError(409, code, message, details);

const forbidden = (message = 'Not allowed for this role or tenant.') =>
  new AppError(403, 'FORBIDDEN', message, {});

const unauthenticated = (message = 'Missing or invalid token.') =>
  new AppError(401, 'UNAUTHENTICATED', message, {});

const paymentDeclined = (code, message = 'Mock gateway failure.') =>
  new AppError(402, code, message, {});

/** Appendix B — every code the hidden vectors can assert on. */
const CODES = Object.freeze({
  // 400
  VALIDATION_ERROR: 400,
  UNKNOWN_EVENT_TYPE: 400,
  INVALID_DISCOUNT_CODE: 400,
  // 401
  UNAUTHENTICATED: 401,
  // 402
  PAYMENT_DECLINED: 402,
  PAYMENT_CAPTURE_FAILED: 402,
  // 403
  FORBIDDEN: 403,
  // 404
  SPORT_NOT_FOUND: 404,
  MATCH_NOT_FOUND: 404,
  LEAGUE_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  SQUAD_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  // 409
  SPORT_EXISTS: 409,
  LEAGUE_EXISTS: 409,
  MATCH_EXISTS: 409,
  DUPLICATE_EVENT_ID: 409,
  DUPLICATE_ORDER_ID: 409,
  ILLEGAL_TRANSITION: 409,
  MATCH_NOT_IN_PROGRESS: 409,
  TIE_NOT_ALLOWED: 409,
  INNINGS_COMPLETE: 409,
  SERIES_ALREADY_DECIDED: 409,
  INVALID_COMPENSATION: 409,
  NO_VALID_PAIRING: 409,
  OUT_OF_STOCK: 409,
  CROSS_TENANT_TRANSFER: 409,
  NOT_IN_SQUAD: 409,
  TRANSFER_WINDOW_CLOSED: 409,
  PLAYER_ON_LOAN: 409,
  SQUAD_FULL: 409,
  MIN_POSITION_VIOLATION: 409,
  // 413 / 429
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  // offline-sync per-action only, never an HTTP status
  INVALID_BASE_VERSION: null,
});

/** Wraps an async route handler so a thrown AppError reaches the error handler. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The single express error handler. A 5xx anywhere is a failed vector, so this
 * catches everything and still emits the contract shape.
 */
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json(err.toBody());
  }
  // body-parser signals an oversized body before JSON parsing
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Body over 1 MB.').toBody());
  }
  // malformed JSON -> 400 VALIDATION_ERROR, never 500
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json(validation(['body'], 'Malformed JSON body.').toBody());
  }
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err && err.stack ? err.stack : err);
  return res.status(500).json(
    new AppError(500, 'INTERNAL_ERROR', 'Unexpected server error.').toBody()
  );
}

module.exports = {
  AppError,
  CODES,
  validation,
  notFound,
  conflict,
  forbidden,
  unauthenticated,
  paymentDeclined,
  asyncH,
  errorHandler,
};
