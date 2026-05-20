/**
 * Append-only JSONL trade log.
 *
 * Each completed (simulated or live) trade is appended as one line of JSON
 * with the shape requested by the user:
 *
 *   {"pair":"XAUUSD","entry":4480.20,"sl":4471.20,"tp":4493.70,
 *    "risk_reward":1.5,"result_pips":135,"duration_minutes":42,
 *    "session":"London","outcome":"WIN", ...}
 *
 * Lives at src/state/trades.jsonl. Used by future Dashboard / /history queries.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TRADE_LOG = join(__dirname, '..', 'state', 'trades.jsonl');

function nyHour(unixSeconds) {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(unixSeconds * 1000)), 10);
}

/** Returns 'Asian' | 'London' | 'NY' | 'PM' for an NY-local hour. */
export function sessionLabel(unixSeconds) {
  const h = nyHour(unixSeconds);
  if (h >= 20 || h < 2) return 'Asian';
  if (h >= 2 && h < 7)  return 'London';
  if (h >= 7 && h < 12) return 'NY-AM';
  if (h >= 12 && h < 16) return 'NY-PM';
  return 'PM';
}

/**
 * Append one trade record. Won't throw on disk failure.
 *
 * @param {object} t  trade record (see lib comment for shape)
 * @param {string} [source]  'backtest' or 'live'
 */
export function appendTrade(t, source = 'backtest') {
  try {
    if (!existsSync(dirname(TRADE_LOG))) mkdirSync(dirname(TRADE_LOG), { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      source,
      ...t,
    };
    appendFileSync(TRADE_LOG, JSON.stringify(row) + '\n');
  } catch (err) {
    // Don't let trade logging break the loop
    console.error('[trade_log] append failed:', err.message);
  }
}

export const TRADE_LOG_PATH = TRADE_LOG;
