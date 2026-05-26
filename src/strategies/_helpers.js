/**
 * Shared building blocks for the 10 add-on strategies (ChatGPT + Gemini packs).
 *
 * Goal: keep each strategy file short and readable by extracting the boilerplate
 * (last-N-bars, range high/low, "did this candle close outside range").
 */

import { atr, findSwings, detectSweep } from '../lib/structure.js';
import { bollinger } from '../lib/indicators.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Get the most recent N closed bars from a pane (excluding the in-progress one). */
export function lastClosedBars(pane, count) {
  if (!pane?.bars?.length) return [];
  // Treat last bar as the "current/forming" bar — exclude it from closed analysis
  // so we don't false-trigger on a partial bar.
  const closed = pane.bars.slice(0, -1);
  return closed.slice(-count);
}

/** Range of an array of bars: { high, low, mid }. */
export function rangeOf(bars) {
  if (!bars?.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  return { high: hi, low: lo, mid: (hi + lo) / 2 };
}

/**
 * Bars in a unix-seconds [start, end) window. Used to scope session-anchored
 * analysis like Asian range or NY VWAP.
 */
export function barsInWindow(bars, startUnix, endUnix) {
  if (!bars?.length) return [];
  return bars.filter((b) => b.time >= startUnix && b.time < endUnix);
}

/**
 * Volume "noticeable" check. Returns true if the last bar's volume is at least
 * `factor` × the avg of the previous `lookback` bars. Defaults to 1.2 — the
 * Gemini playbooks ask for "noticeable volume" which we read as ≥120% average.
 * Null/no-volume bars degrade to true so we don't lock out symbols without volume.
 */
export function volNoticeable(bars, factor = 1.2, lookback = 10) {
  if (!bars || bars.length < lookback + 1) return true;
  const last = bars[bars.length - 1];
  if (!last?.volume) return true; // tolerate missing volume data
  const window = bars.slice(-lookback - 1, -1);
  const hasVol = window.some((b) => (b.volume || 0) > 0);
  if (!hasVol) return true;
  const avg = window.reduce((a, b) => a + (b.volume || 0), 0) / window.length;
  return (last.volume || 0) >= factor * avg;
}

/** Build a stable per-day setupId for a strategy that fires at most once/day. */
export function dayScopedId(strategyKey, dateKey, direction, label = '') {
  return `${strategyKey}|${dateKey}|${direction}|${label}`;
}

/** Compute previous-day high/low for HTF context. */
export function previousDayHL(dailyPane) {
  if (!dailyPane?.bars || dailyPane.bars.length < 2) return null;
  // Most-recent CLOSED daily bar
  const prev = dailyPane.bars[dailyPane.bars.length - 2];
  return { high: prev.high, low: prev.low, date: prev.time };
}

/** True if the most recent closed bar is a bullish engulfing (or pin bar). */
export function lastBullishRejection(bars) {
  if (!bars || bars.length < 2) return false;
  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  // bullish engulfing
  if (cur.close > cur.open && prev.close < prev.open &&
      cur.close >= prev.open && cur.open <= prev.close) return true;
  // bullish pin bar: long lower wick, small body
  if (lowerWick / range >= 0.5 && body / range <= 0.4 && cur.close > cur.open) return true;
  return false;
}

/** True if the most recent closed bar is a bearish engulfing (or pin bar). */
export function lastBearishRejection(bars) {
  if (!bars || bars.length < 2) return false;
  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range <= 0) return false;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  if (cur.close < cur.open && prev.close > prev.open &&
      cur.close <= prev.open && cur.open >= prev.close) return true;
  if (upperWick / range >= 0.5 && body / range <= 0.4 && cur.close < cur.open) return true;
  return false;
}

// Uniform reward profile for every strategy. The strategy supplies entry +
// a structural stop; we widen that stop by STOP_PAD × its distance so market
// noise doesn't stop us out before the move plays. Targets are multiples of
// the *widened* risk — so every winning trade banks at least 1.2R (TP1),
// running to 1.8R (TP2).
export const TP1_R = 1.2;
export const TP2_R = 1.8;
export const STOP_PAD = 0.35;  // widen the structural stop by 35%

// Reward guard-rails (in R, measured against the WIDENED risk). Every target —
// whether an explicit structural price or an R-multiple — is clamped into this
// band so no setup ever ships a target that's too tight (risk more than it
// pays) or unrealistically long (a 30R structural level that never fills, so
// the runner just scratches at breakeven). Bounds chosen to leave the
// already-sane strategies untouched: DAILY-TREND-PB's 3.0R TP2 sits inside the
// 4.0 cap; VWAP's 1.8R sits on the floor; only the structural-target outliers
// (LONDON's Asian-extreme, NY-FVG's session-extreme, ASIAN's range multiples)
// and the STOP_PAD-deflated sub-1R TP1s actually move.
export const TP1_MIN_R = 1.0, TP1_MAX_R = 2.5;
export const TP2_MIN_R = 1.8, TP2_MAX_R = 4.0;

/** Clamp a target PRICE so |price-entry|/risk lands in [minR, maxR]. */
function clampTargetR(entry, sign, risk, price, minR, maxR) {
  const rr = Math.abs(price - entry) / risk;
  const r = Math.min(maxR, Math.max(minR, rr));
  return entry + sign * r * risk;
}

/**
 * Build the standard triggered DetectorResult shape that the alerter expects.
 * Targets + the executed stop are derived from a noise-padded risk so the
 * whole stack ships a consistent 1.2R / 1.8R profile by default. Strategies
 * targeting longer runs (e.g. DAILY-TREND-PB for prop-firm eval pass) can
 * pass `t1Mult` / `t2Mult` to override per-call.
 */
export function buildTriggered({
  strategy, setupId, direction, setupName, summary, confidence, timeframe,
  entry, stop, t1, t2, t1Mult, t2Mult,
}) {
  const sign = direction === 'LONG' ? 1 : -1;
  const structuralRisk = Math.abs(entry - stop);
  const risk = structuralRisk * (1 + STOP_PAD);
  const widenedStop = entry - sign * risk;
  // Target resolution priority:
  //   1. explicit absolute price (t1/t2) — a structural level the strategy
  //      computed (e.g. LONDON-SWEEP t2 = opposite end of the Asian range,
  //      NY-FVG t2 = session hi/lo). These were previously DROPPED by this
  //      destructure, silently overriding every strategy's authored targets
  //      with the generic 1.2R/1.8R — which made e.g. LONDON's TP2 collapse to
  //      a tiny multiple of a shallow sweep's risk instead of the real move.
  //   2. R-multiple (t1Mult/t2Mult) off the widened risk.
  //   3. default 1.2R / 1.8R.
  // A supplied price is only honored if it sits on the correct side of entry
  // (a long's targets above, a short's below) — guards against a bad level.
  const fav = (price) => Number.isFinite(price) && sign * (price - entry) > 0;
  const resolvedT1 = fav(t1) ? t1 : entry + sign * (t1Mult ?? TP1_R) * risk;
  const resolvedT2 = fav(t2) ? t2 : entry + sign * (t2Mult ?? TP2_R) * risk;
  // Guard-rail every target into a tradeable RR band (see clampTargetR above).
  let finalT1 = clampTargetR(entry, sign, risk, resolvedT1, TP1_MIN_R, TP1_MAX_R);
  let finalT2 = clampTargetR(entry, sign, risk, resolvedT2, TP2_MIN_R, TP2_MAX_R);
  // TP2 must sit strictly beyond TP1 (a clamped structural level could otherwise
  // collide with or fall short of TP1).
  if (sign * (finalT2 - finalT1) <= 0) {
    const t1r = Math.abs(finalT1 - entry) / risk;
    finalT2 = entry + sign * Math.min(TP2_MAX_R, t1r + 0.5) * risk;
  }
  stop = widenedStop;
  return {
    strategy,
    setupId,
    status: 'triggered',
    direction,
    setupName,
    summary,
    confidence: confidence ?? 0.7,
    timeframe,
    details: {},
    invalidationLevel: stop,
    entryPlan: { entry, stop, t1: finalT1, t2: finalT2, runner: finalT2, risk },
  };
}

/** Clamp a number to the 0..1 range. */
export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Project what a triggered trade would look like RIGHT NOW given a hypothetical
 * entry + structural stop. Used by precheck() so /setups can show forming
 * setups with their would-be entry/stop/TP/RR values. Mirrors buildTriggered()
 * math so the projection matches what the alert would actually fire with.
 */
export function projectTrade({ direction, entry, stop, t1, t2, t1Mult, t2Mult }) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !direction) return null;
  const sign = direction === 'LONG' ? 1 : -1;
  const structuralRisk = Math.abs(entry - stop);
  if (structuralRisk <= 0) return null;
  const risk = structuralRisk * (1 + STOP_PAD);
  const widenedStop = entry - sign * risk;
  // Mirror buildTriggered's target resolution: explicit price → R-mult → default.
  const fav = (price) => Number.isFinite(price) && sign * (price - entry) > 0;
  const rt1raw = fav(t1) ? t1 : entry + sign * (t1Mult ?? TP1_R) * risk;
  const rt2raw = fav(t2) ? t2 : entry + sign * (t2Mult ?? TP2_R) * risk;
  // Mirror buildTriggered's RR guard-rails so /setups shows the same levels the
  // fired alert will use.
  let rt1 = clampTargetR(entry, sign, risk, rt1raw, TP1_MIN_R, TP1_MAX_R);
  let rt2 = clampTargetR(entry, sign, risk, rt2raw, TP2_MIN_R, TP2_MAX_R);
  if (sign * (rt2 - rt1) <= 0) {
    const t1r = Math.abs(rt1 - entry) / risk;
    rt2 = entry + sign * Math.min(TP2_MAX_R, t1r + 0.5) * risk;
  }
  return {
    entry: round4(entry),
    stop: round4(widenedStop),
    t1: round4(rt1),
    t2: round4(rt2),
    risk: round4(risk),
    rr1: round4(Math.abs(rt1 - entry) / risk),
    rr2: round4(Math.abs(rt2 - entry) / risk),
  };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

// ── Win-rate-grounded confidence ────────────────────────────────────────
// Confidence must MEAN something: a 67% should mean roughly two of every
// three of those setups win. So a signal's confidence is anchored to the
// strategy's REAL backtested win rate, then shifted by how good this
// specific setup looks. The base rate is read live from the nightly
// backtest cache; the defaults below are the last verified 30-day run so
// the system is accurate even before the first cache refresh.
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'backtest-cache.json');
// Conservative side of the run-to-run range observed across multiple 45-day
// backtests — the nightly backtest cache overrides these once it runs.
const DEFAULT_WIN_RATES = {
  'ASIAN-BREAKOUT': 0.63,
  'DAILY-TREND-PB': 0.60,
  'EMA-CROSS': 0.62,
  'LONDON-SWEEP': 0.72,
  'NY-FVG': 0.68,
  'VWAP-REJ': 0.55,
};
let _winRates = { rates: null, at: 0 };

/** Live per-strategy win rates from the nightly backtest cache (10-min TTL). */
function winRateFor(strategyId) {
  const now = Date.now();
  if (!_winRates.rates || now - _winRates.at > 600_000) {
    let rates = {};
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      if (cache && cache.winRates && typeof cache.winRates === 'object') rates = cache.winRates;
    } catch { /* no cache yet — fall back to defaults */ }
    _winRates = { rates, at: now };
  }
  const live = _winRates.rates[strategyId];
  return (typeof live === 'number' && live > 0) ? live : (DEFAULT_WIN_RATES[strategyId] ?? 0.62);
}

/**
 * Confidence for a setup — anchored to the strategy's empirical win rate.
 *
 * `base` is the strategy's real backtested win rate. The mean of the
 * per-setup quality factors (0..1, where 0.5 is an average setup) shifts
 * confidence up to ±0.12 around that base: a clean, high-displacement setup
 * scores above the strategy average, a marginal one below. Clamped 0.50–0.95.
 *
 * @param {string} strategyId  meta.id of the strategy
 * @param {number[]} factors   0..1 quality signals for THIS setup
 */
export function qualityConfidence(strategyId, factors) {
  const base = winRateFor(strategyId);
  const vals = (Array.isArray(factors) ? factors : []).map(clamp01);
  const quality = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.5;
  const conf = base + 0.12 * (quality - 0.5) * 2;
  return Math.round(Math.max(0.50, Math.min(0.95, conf)) * 100) / 100;
}

/**
 * Bollinger band width for the last `count` bars. The lib's bollinger() only
 * returns the latest bar's band, so we re-evaluate it on progressively shorter
 * slices. Returns oldest→newest array of { upper, lower, mid, width }.
 */
export function bollingerSeries(bars, count, period = 20, mult = 2) {
  const out = [];
  const n = bars.length;
  for (let k = Math.max(period, n - count); k <= n; k++) {
    const b = bollinger(bars.slice(0, k), period, mult);
    if (b) out.push({ upper: b.upper, lower: b.lower, mid: b.mid, width: b.upper - b.lower });
  }
  return out;
}

// Re-export so strategies don't need to know which file each helper lives in.
export { atr, findSwings, detectSweep };
