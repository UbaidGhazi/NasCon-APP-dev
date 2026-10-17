'use strict';
/**
 * Internal job queue consumer (Redis Streams).
 *
 * FR-2.3 requires each order-state transition to emit a structured domain event
 * to an internal queue. That queue is not script-graded, so this stays
 * deliberately small: consume, log, acknowledge. Do not build Celery here.
 */

const { redis, shutdown, connectRedis } = require('./config');

const STREAMS = ['domain:orders', 'domain:matches', 'domain:roster'];
const GROUP = 'workers';
const CONSUMER = `worker-${process.pid}`;

async function ensureGroups() {
  await connectRedis();
  for (const s of STREAMS) {
    try {
      await redis.xgroup('CREATE', s, GROUP, '$', 'MKSTREAM');
    } catch (e) {
      if (!String(e.message).includes('BUSYGROUP')) throw e;
    }
  }
}

async function loop() {
  await ensureGroups();
  console.log(`[worker] consuming ${STREAMS.join(', ')}`);

  for (;;) {
    try {
      const res = await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', 20,
        'BLOCK', 5000,
        'STREAMS', ...STREAMS, ...STREAMS.map(() => '>')
      );
      if (!res) continue;

      for (const [stream, entries] of res) {
        for (const [id, fields] of entries) {
          const idx = fields.indexOf('payload');
          const payload = idx >= 0 ? fields[idx + 1] : '{}';
          console.log(`[worker] ${stream} ${id} ${payload}`);
          await redis.xack(stream, GROUP, id);
        }
      }
    } catch (e) {
      console.error('[worker]', e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });

loop().catch(async (e) => {
  console.error('[worker] fatal:', e);
  await shutdown();
  process.exit(1);
});
