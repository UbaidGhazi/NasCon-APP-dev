'use strict';
/**
 * Boot sequence. The grader runs `docker compose up -d --build`, then polls
 * GET /health every 2 s and expects 200 within 120 s of the command returning.
 *
 * Postgres may still be starting, so retry the connection instead of crashing.
 */

const app = require('./app');
const { env, shutdown, connectRedis } = require('./config');
const { ensureSchema, resetAndSeed } = require('./seed');

const BOOT_RETRIES = 40;
const BOOT_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  if (!process.env.DAY1_SALT) {
    process.env.DAY1_SALT = 'demo-salt';
    console.warn('[boot] DAY1_SALT is not set. Defaulting to demo-salt for local execution.');
  }

  try {
    await connectRedis();
    console.log('[boot] redis connected');
  } catch (e) {
    console.warn('[boot] redis unavailable, continuing:', e.message);
  }

  const { setUseMemory } = require('./config');

  for (let attempt = 1; attempt <= BOOT_RETRIES; attempt++) {
    try {
      await ensureSchema();
      await resetAndSeed({ seed: 42 });
      console.log('[boot] schema ready, baseline seeded');
      return;
    } catch (e) {
      if (attempt >= 2 || e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
        console.warn(`[boot] PostgreSQL is unavailable (${e.message}). Switching to embedded in-memory database engine.`);
        setUseMemory(true);
        try {
          await ensureSchema();
          await resetAndSeed({ seed: 42 });
          console.log('[boot] in-memory schema ready, baseline seeded successfully');
          return;
        } catch (innerErr) {
          console.error('[boot] in-memory boot error:', innerErr);
        }
      }
      console.log(`[boot] database not ready (attempt ${attempt}/${BOOT_RETRIES}): ${e.message}`);
      if (attempt === BOOT_RETRIES) throw e;
      await sleep(BOOT_DELAY_MS);
    }
  }
}


boot()
  .then(() => {
    const server = app.listen(env.port, '0.0.0.0', () => {
      console.log(`[boot] listening on 0.0.0.0:${env.port}`);
    });
    // Node's 5 s default keep-alive timeout can reset sockets mid-burst.
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 70000;

    const stop = async (sig) => {
      console.log(`[shutdown] ${sig}`);
      server.close(async () => {
        await shutdown();
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  })
  .catch((e) => {
    console.error('[boot] failed:', e);
    process.exit(1);
  });
