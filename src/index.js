import { config } from './config.js';
import { log } from './logger.js';
import { snapshot } from './tvClient.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import { run, stop } from './loop.js';

const verifyMode = process.argv.includes('--verify');

async function bestEffortSnapshot() {
  try {
    const s = await snapshot();
    if (!s) return { symbol: 'GOLD (cloud)', timeframe: '5' }; // tradingview-mcp missing (VPS)
    return s;
  } catch (err) {
    log.warn('initial snapshot failed (TV may not be up yet)', { err: err.message });
    return { symbol: 'GOLD', timeframe: '5' };
  }
}

async function main() {
  log.info('starting', { verify: verifyMode, pid: process.pid, node: process.version });

  const ctx = await bestEffortSnapshot();
  const sent = await alerter.sendStartup({ symbol: ctx.symbol, timeframe: ctx.timeframe });
  if (!sent) {
    log.error('startup telegram failed — check credentials');
    if (verifyMode) process.exit(1);
  } else {
    log.info('startup telegram sent', { symbol: ctx.symbol, timeframe: ctx.timeframe });
  }

  if (verifyMode) {
    log.info('verify mode — exiting');
    process.exit(0);
  }

  const shutdown = (sig) => {
    log.info('shutdown signal', { sig });
    stop();
    dedup.flushNow();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { reason: String(reason) });
    process.exit(1);
  });

  await run();
}

main().catch((err) => {
  log.error('main crashed', { err: err.message, stack: err.stack });
  process.exit(1);
});
