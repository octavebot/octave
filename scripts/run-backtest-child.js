#!/usr/bin/env node
/**
 * Crash-isolated backtest runner.
 *
 * Spawned as a CHILD process by the bot. The bot pipes stdout/stderr back
 * to Telegram. If this script OOMs or throws, the parent bot stays alive.
 *
 * Usage:
 *   node scripts/run-backtest-child.js --days 30
 *   node scripts/run-backtest-child.js --days 60 --strategy TRINITY
 *   node scripts/run-backtest-child.js --days 30 --post   (also sends to Telegram)
 *
 * Output: structured "RESULT:<json>" line on stdout when complete, plus a
 * "TG:<markdown>" line containing the Telegram message body. The parent
 * picks these up and forwards.
 */

import { runBacktest, suggestionsFor, formatTelegramSummary } from '../src/backtest.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = join(REPO, 'src', 'state', 'backtest-cache.json');

async function main() {
  const argv = process.argv.slice(2);
  const sIdx = argv.indexOf('--strategy');
  const strategy = sIdx >= 0 ? argv[sIdx + 1] : null;
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? parseInt(argv[dIdx + 1], 10) || 30 : 30;

  const opts = { days };
  if (strategy) opts.strategies = [strategy];

  const startedAt = Date.now();
  const result = await runBacktest(opts);
  const durationMs = Date.now() - startedAt;
  if (result.error) {
    console.log(`RESULT:${JSON.stringify({ error: result.error, durationMs })}`);
    process.exit(1);
  }
  const suggestions = suggestionsFor(result.stats);
  const tg = formatTelegramSummary(result, suggestions);

  // A full all-strategies run (no --strategy) updates the cache that the
  // Telegram /backtest command serves instantly — the VPS is too slow to run
  // a 30-day backtest live within the command timeout.
  if (!strategy) {
    try {
      // Per-strategy win rates feed the confidence model — a signal's
      // confidence is anchored to its strategy's real win rate. Only
      // strategies with a meaningful sample (>=10 trades) are published.
      const winRates = {};
      for (const [id, s] of Object.entries(result.stats || {})) {
        if (s && typeof s.winRate === 'number' && (s.tradeCount || 0) >= 10) {
          winRates[id] = Math.round(s.winRate * 1000) / 1000;
        }
      }
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify({ generatedAt: Date.now(), days, durationMs, winRates, tg }, null, 2));
    } catch (err) {
      console.error('cache write failed:', err.message);
    }
  }

  // Emit both — the parent reads RESULT for telemetry and TG for the message.
  // We base64-encode TG to avoid newline parsing issues in the IPC.
  const tgB64 = Buffer.from(tg, 'utf8').toString('base64');
  console.log(`RESULT:${JSON.stringify({ ok: true, stats: result.stats, window: result.window, durationMs })}`);
  console.log(`TG:${tgB64}`);
}

// Global safety nets — log + exit cleanly so parent can see what happened
process.on('uncaughtException', (err) => {
  console.error('CHILD_UNCAUGHT:', err.message, err.stack);
  console.log(`RESULT:${JSON.stringify({ error: 'uncaught: ' + err.message })}`);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  console.error('CHILD_REJECTED:', err?.message || err);
  console.log(`RESULT:${JSON.stringify({ error: 'unhandled: ' + (err?.message || err) })}`);
  process.exit(3);
});

main().catch((e) => {
  console.error('CHILD_MAIN_THREW:', e.message, e.stack);
  console.log(`RESULT:${JSON.stringify({ error: e.message })}`);
  process.exit(4);
});
