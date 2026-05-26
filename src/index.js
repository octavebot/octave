import { config } from './config.js';
import { log } from './logger.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import { run, stop } from './loop.js';
import { syncRegistryToConfig } from './lib/runtime_config.js';

const verifyMode = process.argv.includes('--verify');

// The cloud bot reads market data from the Yahoo / OANDA / TradingView-bridge
// feeds, not from a local TradingView chart, so there's no chart to snapshot.
// (The old tvClient/MCP snapshot path was Mac-only and always failed here —
// removed along with the tradingview-mcp dependency.)
function bestEffortSnapshot() {
  return { symbol: 'MGC1! (cloud)', timeframe: '15' };
}

async function main() {
  log.info('starting', { verify: verifyMode, pid: process.pid, node: process.version });

  // Auto-add any new strategies from the registry to runtime-config.json so
  // they're enabled out of the box. Quiet no-op when the config already has them.
  try { await syncRegistryToConfig(); } catch (err) {
    log.warn('syncRegistryToConfig failed', { err: err.message });
  }

  // Auto-enable the Lucid Flex paper trader for both accounts on startup.
  // Auto-enable paper tracking on startup so the user doesn't have to type
  // `/risk on` after every restart. Wrapped so a bad import never blocks
  // startup. (Live execution is intentionally not wired — paper only.)
  try {
    const at = await import('./lib/account_tracker.js');
    for (const id of at.ACCOUNT_IDS) {
      const acc = at.get(id);
      if (acc && !acc.enabled) {
        at.setEnabled(id, true);
        log.info('paper trader auto-enabled', { account: id });
      }
    }
  } catch (err) {
    log.warn('paper-trader auto-enable failed', { err: err.message });
  }

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
