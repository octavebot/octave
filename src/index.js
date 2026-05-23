import { config } from './config.js';
import { log } from './logger.js';
import { snapshot } from './tvClient.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import { run, stop } from './loop.js';
import { syncRegistryToConfig } from './lib/runtime_config.js';

const verifyMode = process.argv.includes('--verify');

async function bestEffortSnapshot() {
  // 15m is the user-visible "watching" TF — all alerts gate at 15m+.
  try {
    const s = await snapshot();
    if (!s) return { symbol: 'MGC1! (cloud)', timeframe: '15' };
    return s;
  } catch (err) {
    log.warn('initial snapshot failed (TV may not be up yet)', { err: err.message });
    return { symbol: 'MGC1!', timeframe: '15' };
  }
}

async function main() {
  log.info('starting', { verify: verifyMode, pid: process.pid, node: process.version });

  // Auto-add any new strategies from the registry to runtime-config.json so
  // they're enabled out of the box. Quiet no-op when the config already has them.
  try { await syncRegistryToConfig(); } catch (err) {
    log.warn('syncRegistryToConfig failed', { err: err.message });
  }

  // Auto-enable the Lucid Flex paper trader for both accounts on startup.
  // Paper-mode is the default — live execution requires an explicit
  // `/risk auto live` opt-in. This is the "connect my account" automation:
  // the user doesn't have to remember to type `/risk on` every time the
  // service restarts. Wrapped so a bad import never blocks startup.
  try {
    const at = await import('./lib/account_tracker.js');
    for (const id of ['auto', 'user']) {
      const acc = at.get(id);
      if (acc && !acc.enabled && (acc.mode || 'paper') === 'paper') {
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
