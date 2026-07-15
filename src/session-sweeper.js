const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function startSessionSweeper(store, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const logger = options.logger || console;

  let timer = null;
  let running = false;

  async function sweep() {
    if (running) return;
    running = true;
    try {
      const count = await store.sweepStale(staleAfterMs);
      if (count > 0) {
        logger.info(`[Sweeper] removed ${count} stale session(s)`);
      }
    } catch (err) {
      logger.error(`[Sweeper] error: ${err.message}`);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    sweep();
    timer = setInterval(sweep, intervalMs);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
    logger.info(`[Sweeper] started (interval=${intervalMs / 60000}m, ttl=${staleAfterMs / 86400000}d)`);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    logger.info('[Sweeper] stopped');
  }

  return { start, stop, sweep };
}

module.exports = { startSessionSweeper, STALE_AFTER_MS, CHECK_INTERVAL_MS };
