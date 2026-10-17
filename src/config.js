'use strict';
/**
 * Environment, Postgres pool, Redis, and the transaction helper.
 *
 * THE TRANSACTION TRAP: pool.query('BEGIN') does NOT start a transaction you can
 * rely on — node-postgres may hand each query a different connection, so a
 * SELECT ... FOR UPDATE lock lands on one connection and the UPDATE on another.
 * That is exactly how the 20-buyer oversell test fails. Always use withTx().
 */

const { Pool } = require('pg');
const Redis = require('ioredis');

const env = {
  port: parseInt(process.env.PORT || '8080', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://nascon:nascon@db:5432/nascon',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  jwtSecret: process.env.JWT_SECRET || 'nascon-dev-jwt-secret',
  // DAY1_SALT is deliberately NOT cached here — src/signing.js reads it from
  // process.env at call time so it can never be baked into a build artifact.
};

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 30, // the 20-request checkout burst needs headroom above 20
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (e) => console.error('[pg pool]', e.message));

// lazyConnect is deliberate: a connection opened at import time keeps the Node
// event loop alive forever when Redis is absent, which hangs every unit test
// that merely `require`s a module importing this file. Connected in server.js.
const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableOfflineQueue: true,
});
redis.on('error', (e) => console.error('[redis]', e.message));

const { memoryDB } = require('./in_memory_db');

let fallbackToMemory = false;

function setUseMemory(val) {
  fallbackToMemory = val;
}

/** Called once from server.js / worker.js. Never from a route or a test. */
async function connectRedis() {
  if (redis.status === 'ready' || redis.status === 'connecting') return;
  await redis.connect();
}

const origPoolQuery = pool.query.bind(pool);
pool.query = async (text, params) => {
  if (fallbackToMemory) return memoryDB.query(text, params);
  try {
    return await origPoolQuery(text, params);
  } catch (err) {
    if (!fallbackToMemory && (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED')) {
      console.warn('[db] PostgreSQL unavailable, switching to embedded in-memory database.');
      fallbackToMemory = true;
      return memoryDB.query(text, params);
    }
    throw err;
  }
};

/**
 * Run fn inside ONE dedicated connection wrapped in BEGIN/COMMIT.
 * fn receives that client — every query inside must use it, not `pool`.
 */
async function withTx(fn) {
  if (fallbackToMemory) {
    return memoryDB.withTx(fn);
  }
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    if (!fallbackToMemory && (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED')) {
      console.warn('[db] PostgreSQL unavailable, switching to embedded in-memory database.');
      fallbackToMemory = true;
      return memoryDB.withTx(fn);
    }
    throw err;
  }
}

/** Convenience for single statements that need no transaction. */
const q = (text, params) => {
  if (fallbackToMemory) return memoryDB.query(text, params);
  return pool.query(text, params);
};

/** Emit a domain event to the internal queue (Redis Streams). Fire and forget. */
async function emitDomainEvent(stream, payload) {
  try {
    await redis.xadd(stream, '*', 'payload', JSON.stringify(payload));
  } catch (e) {
    // never fail a request over the queue
  }
}

async function shutdown() {
  await Promise.allSettled([pool.end(), redis.quit()]);
}

module.exports = { env, pool, redis, connectRedis, withTx, q, emitDomainEvent, shutdown, setUseMemory, memoryDB };

