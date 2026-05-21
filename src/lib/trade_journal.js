/**
 * Trade journal — user-reported trade state.
 *
 * Captures what the user actually did with a setup (vs. what the bot
 * suggested). Each event is appended to src/state/trade-journal.jsonl;
 * derived stats are computed on demand so the file is the source of truth.
 *
 * Event shapes (action determines required fields):
 *   { action: 'in',    setupId, instrument, strategy?, contracts, price, ts }
 *   { action: 'out',   setupId, reason, price, contracts?, ts }    // reason: 'tp1','tp2','sl','be','manual'
 *   { action: 'be',    setupId, ts }
 *   { action: 'note',  setupId, text, ts }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JOURNAL_FILE = join(__dirname, '..', 'state', 'trade-journal.jsonl');

function ensureDir() { mkdirSync(dirname(JOURNAL_FILE), { recursive: true }); }

/** Append one event. Returns the event with a stable id. */
export function log(event) {
  ensureDir();
  const enriched = { ts: Date.now(), ...event };
  appendFileSync(JOURNAL_FILE, JSON.stringify(enriched) + '\n');
  return enriched;
}

/** Read all events newest-first, optionally filtered. */
export function read({ since = 0, limit = Infinity, setupId, action } = {}) {
  if (!existsSync(JOURNAL_FILE)) return [];
  const lines = readFileSync(JOURNAL_FILE, 'utf8').split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try {
      const ev = JSON.parse(ln);
      if (ev.ts < since) break;
      if (setupId && ev.setupId !== setupId) continue;
      if (action && ev.action !== action) continue;
      out.push(ev);
      if (out.length >= limit) break;
    } catch {}
  }
  return out;
}

/**
 * Reconstruct one trade by walking its events.
 * Returns { setupId, instrument, strategy, contracts, entryPrice, entryTs,
 *           exitPrice, exitTs, exitReason, isBE, notes[], R? }
 */
export function trade(setupId) {
  const events = read({ setupId }).reverse(); // chronological
  if (!events.length) return null;
  const t = { setupId, notes: [] };
  for (const e of events) {
    if (e.action === 'in') {
      t.entryPrice = e.price;
      t.entryTs = e.ts;
      t.contracts = e.contracts;
      t.instrument = e.instrument || t.instrument;
      t.strategy = e.strategy || t.strategy;
    } else if (e.action === 'out') {
      t.exitPrice = e.price;
      t.exitTs = e.ts;
      t.exitReason = e.reason;
    } else if (e.action === 'be') {
      t.isBE = true;
      t.beTs = e.ts;
    } else if (e.action === 'note') {
      t.notes.push({ ts: e.ts, text: e.text });
    }
  }
  // R calc requires a reference SL — caller can pass risk in or compute later.
  return t;
}

/** List of unique setup ids in journal, newest activity first. */
export function recentTrades(limit = 20) {
  const seen = new Map();
  for (const e of read({ limit: 5000 })) {
    if (!e.setupId) continue;
    if (!seen.has(e.setupId)) seen.set(e.setupId, e.ts);
  }
  const ids = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  return ids.map((id) => trade(id)).filter(Boolean);
}

/** Aggregate stats over last N days. */
export function stats(days = 7) {
  const since = Date.now() - days * 86400_000;
  const trades = recentTrades(500).filter((t) => (t.entryTs || 0) >= since && t.exitPrice != null);
  let wins = 0, losses = 0, totalContracts = 0;
  for (const t of trades) {
    if (t.exitReason === 'tp1' || t.exitReason === 'tp2') wins++;
    else if (t.exitReason === 'sl') losses++;
    if (t.contracts) totalContracts += t.contracts;
  }
  const closed = wins + losses;
  return {
    days,
    totalTrades: trades.length,
    closedTrades: closed,
    openTrades: trades.length - closed,
    wins, losses,
    winRate: closed ? wins / closed : 0,
    totalContracts,
    byReason: trades.reduce((m, t) => {
      const r = t.exitReason || 'open';
      m[r] = (m[r] || 0) + 1; return m;
    }, {}),
  };
}

/** Open trades (no exit recorded). */
export function openTrades() {
  return recentTrades(200).filter((t) => t.entryPrice != null && t.exitPrice == null);
}
