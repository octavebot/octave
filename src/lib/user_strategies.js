/**
 * User-editable strategies.
 *
 * Stored as JSON in src/state/user-strategies.json. Each entry is a constrained
 * spec — not arbitrary code — so a non-coder can wire something useful from
 * the dashboard or Telegram without risking RCE.
 *
 * Schema (one item):
 *   {
 *     id:        "my-ema-cross"        // unique key, kebab-case, persists across renames
 *     name:      "My EMA Cross"        // display name
 *     description: "..."
 *     timeframe: "15" | "30" | "60" | "240"   // 15m+ per global gate
 *     direction: "auto" | "long" | "short"
 *     entry:     "ema_cross" | "ema_pullback" | "bb_extreme" | "rsi_bounds"
 *     fast: number       // EMA fast period (default 9)
 *     slow: number       // EMA slow period (default 21)
 *     rsi_min: number    // 0-100 — gate longs only if RSI >= this
 *     rsi_max: number    // 0-100 — gate shorts only if RSI <= this
 *     stop_atr_mult: number   // SL distance in ATR(14) units
 *     tp_r: number       // TP = N × risk
 *     enabled: boolean   // mirrored in runtime-config.strategies[id] as well
 *   }
 *
 * The evaluator emits standard DetectorResult objects so they flow through
 * the same alert + follow-up + drawing pipelines as the built-ins.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ema, emaLast, rsiLast, bollinger, isPinBar, isEngulfing } from './indicators.js';
import { atr } from './structure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STORE_FILE = join(__dirname, '..', 'state', 'user-strategies.json');

const ALLOWED_TF = new Set(['15', '30', '60', '240']);
const ALLOWED_DIRECTION = new Set(['auto', 'long', 'short']);
const ALLOWED_ENTRY = new Set(['ema_cross', 'ema_pullback', 'bb_extreme', 'rsi_bounds']);
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,40}$/i;

function load() {
  if (!existsSync(STORE_FILE)) {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    return { items: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    return { items: Array.isArray(raw?.items) ? raw.items : [] };
  } catch {
    return { items: [] };
  }
}

let store = load();

function save() {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STORE_FILE);
}

/** Re-read from disk — called by the detector each tick so edits propagate. */
export function refresh() { store = load(); return store.items; }

export function list() { return [...store.items]; }

export function get(id) {
  return store.items.find((s) => s.id === id) || null;
}

/**
 * Validate a strategy spec — returns the normalized object on success or
 * throws with a user-friendly message on failure.
 */
export function validate(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('payload must be an object');
  const id = String(spec.id || '').trim();
  if (!ID_PATTERN.test(id)) throw new Error('id must be 2-40 chars (a-z, 0-9, -, _)');
  const name = String(spec.name || '').trim();
  if (!name) throw new Error('name is required');
  const tf = String(spec.timeframe || '15');
  if (!ALLOWED_TF.has(tf)) throw new Error(`timeframe must be one of ${[...ALLOWED_TF].join(',')}`);
  const direction = String(spec.direction || 'auto');
  if (!ALLOWED_DIRECTION.has(direction)) throw new Error('direction must be auto/long/short');
  const entry = String(spec.entry || 'ema_cross');
  if (!ALLOWED_ENTRY.has(entry)) throw new Error(`entry must be one of ${[...ALLOWED_ENTRY].join(',')}`);
  const fast = clampInt(spec.fast, 2, 200, 9);
  const slow = clampInt(spec.slow, 2, 400, 21);
  if (fast >= slow) throw new Error('fast EMA period must be < slow EMA period');
  const rsi_min = clampInt(spec.rsi_min, 0, 100, 0);
  const rsi_max = clampInt(spec.rsi_max, 0, 100, 100);
  const stop_atr_mult = clampNum(spec.stop_atr_mult, 0.1, 10, 1.5);
  const tp_r = clampNum(spec.tp_r, 0.5, 20, 2);
  const description = String(spec.description || '').slice(0, 280);
  const enabled = spec.enabled === false ? false : true;
  return { id, name, description, timeframe: tf, direction, entry,
           fast, slow, rsi_min, rsi_max, stop_atr_mult, tp_r, enabled,
           updatedAt: Date.now() };
}

function clampInt(v, lo, hi, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function clampNum(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

export function create(spec) {
  const normalized = validate(spec);
  if (store.items.some((s) => s.id === normalized.id)) {
    throw new Error(`id "${normalized.id}" already exists`);
  }
  store.items.push(normalized);
  save();
  return normalized;
}

export function update(id, spec) {
  const idx = store.items.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error(`strategy "${id}" not found`);
  const normalized = validate({ ...spec, id });
  store.items[idx] = normalized;
  save();
  return normalized;
}

export function remove(id) {
  const before = store.items.length;
  store.items = store.items.filter((s) => s.id !== id);
  if (store.items.length === before) throw new Error(`strategy "${id}" not found`);
  save();
}

// ─── Evaluator ───────────────────────────────────────────────────────────

/**
 * Run all enabled user strategies for a ctx. Returns DetectorResult[].
 * Each tick the detector calls this; we read latest from disk for hot-reload.
 */
export function evaluateUserStrategies(ctx, isStrategyEnabledFn) {
  refresh();
  const out = [];
  for (const spec of store.items) {
    if (!spec.enabled) continue;
    // Honor the runtime-config toggle if present (lets the user disable from
    // Telegram /disable <id> without losing the strategy definition).
    if (isStrategyEnabledFn && !isStrategyEnabledFn(spec.id)) continue;
    try {
      const r = evaluateOne(spec, ctx);
      if (r) out.push(r);
    } catch (err) {
      console.error(`[user-strategy:${spec.id}] threw:`, err.message);
    }
  }
  return out;
}

function evaluateOne(spec, ctx) {
  const pane = ctx.panesByTf.get(`gold|${spec.timeframe}`);
  if (!pane || pane.bars.length < Math.max(spec.slow + 5, 60)) return null;
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!last || !prev) return null;

  let direction = null;
  let summary = '';

  switch (spec.entry) {
    case 'ema_cross': {
      const f = ema(bars, spec.fast);
      const s = ema(bars, spec.slow);
      const fL = f[f.length - 1], fP = f[f.length - 2];
      const sL = s[s.length - 1], sP = s[s.length - 2];
      if (fL == null || sL == null || fP == null || sP == null) return null;
      const crossedUp = fP <= sP && fL > sL;
      const crossedDown = fP >= sP && fL < sL;
      if (crossedUp) direction = 'LONG';
      else if (crossedDown) direction = 'SHORT';
      summary = `EMA(${spec.fast}/${spec.slow}) cross ${direction || ''}`;
      break;
    }
    case 'ema_pullback': {
      const s = emaLast(bars, spec.slow);
      if (s == null) return null;
      const touchedLong = last.low <= s && last.high >= s && last.close > s && isPinBar(last, 'bullish');
      const touchedShort = last.low <= s && last.high >= s && last.close < s && isPinBar(last, 'bearish');
      if (touchedLong) direction = 'LONG';
      else if (touchedShort) direction = 'SHORT';
      summary = `Pullback to EMA(${spec.slow}) + pin bar`;
      break;
    }
    case 'bb_extreme': {
      const bb = bollinger(bars, 20, 2);
      if (!bb) return null;
      if (prev.high > bb.upper && last.close < bb.upper) direction = 'SHORT';
      else if (prev.low < bb.lower && last.close > bb.lower) direction = 'LONG';
      summary = `BB extreme reversal (20, 2σ)`;
      break;
    }
    case 'rsi_bounds': {
      const r = rsiLast(bars, 14);
      if (r == null) return null;
      // long when RSI exits oversold; short when RSI exits overbought
      if (r > 30 && r < 50) direction = 'LONG';   // simplistic: bouncing off oversold
      else if (r < 70 && r > 50) direction = 'SHORT';
      summary = `RSI ${r.toFixed(0)} → ${direction || 'neutral'}`;
      break;
    }
    default:
      return null;
  }
  if (!direction) return null;
  if (spec.direction === 'long' && direction !== 'LONG') return null;
  if (spec.direction === 'short' && direction !== 'SHORT') return null;
  // Optional RSI gate
  const r = rsiLast(bars, 14);
  if (r != null) {
    if (direction === 'LONG' && r < spec.rsi_min) return null;
    if (direction === 'SHORT' && r > spec.rsi_max) return null;
  }

  const a = atr(bars, 14);
  if (!a) return null;
  const entry = last.close;
  const risk = a * spec.stop_atr_mult;
  const stop = direction === 'LONG' ? entry - risk : entry + risk;
  const t1 = direction === 'LONG' ? entry + spec.tp_r * risk : entry - spec.tp_r * risk;

  return {
    strategy: spec.id,
    setupId: `${spec.id}|${last.time}|${direction}`,
    status: 'triggered',
    direction,
    setupName: `${spec.name} — ${direction}`,
    summary,
    confidence: 0.7,
    timeframe: spec.timeframe,
    details: { rsi: r ?? null, atr: a },
    invalidationLevel: stop,
    entryPlan: { entry, stop, t1, t2: t1, risk },
  };
}
