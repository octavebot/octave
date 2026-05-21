/**
 * Strategy CGT #5 — HTF Supply & Demand Sniper (ChatGPT pack).
 *
 * Playbook (verbatim from HTF SUPPLY & DEMAND.pdf):
 *   - Mark 4H supply and demand zones (recent strong-impulse OBs).
 *   - Wait for price to revisit a fresh zone.
 *   - Drop to 5m for confirmation.
 *   - Enter after displacement candle.
 *   - SL outside zone.
 *   - Target next HTF liquidity zone.
 *
 * Note: we only have 60m and daily HTF Yahoo data; we resample 60m up to 4h
 * by grouping 4 consecutive bars.
 *
 * Internal id: CGT-HTFSD
 */

import { atr } from '../../lib/structure.js';
import { dayScopedId, buildTriggered } from '../_helpers.js';
import { nyParts } from '../../lib/time.js';

const KEY = 'CGT-HTFSD';
const TF = '60';        // analysis TF — anchor the alert to 60m (passes 15m+ gate)
const NAME = 'HTF Supply & Demand Sniper';

/** Resample 60m bars into 4h candles (4 → 1). */
function to4h(bars60) {
  const out = [];
  for (let i = 0; i + 4 <= bars60.length; i += 4) {
    const grp = bars60.slice(i, i + 4);
    out.push({
      time: grp[0].time,
      open: grp[0].open,
      high: Math.max(...grp.map((b) => b.high)),
      low: Math.min(...grp.map((b) => b.low)),
      close: grp[grp.length - 1].close,
      volume: grp.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  return out;
}

/**
 * Find recent HTF demand/supply zones: a candle whose body is followed by
 * a strong impulse in the opposite color (≥ 1.5×ATR body).
 * Demand = last DOWN candle before strong UP impulse.
 * Supply = last UP candle before strong DOWN impulse.
 */
function findZones(bars4h, atrVal) {
  const zones = [];
  for (let i = 1; i < bars4h.length - 1; i++) {
    const candle = bars4h[i - 1];
    const impulse = bars4h[i];
    const body = Math.abs(impulse.close - impulse.open);
    if (body < 1.5 * atrVal) continue;
    if (impulse.close > impulse.open && candle.close < candle.open) {
      zones.push({ type: 'demand', top: candle.high, bottom: candle.low, idx: i - 1, freshSince: candle.time });
    }
    if (impulse.close < impulse.open && candle.close > candle.open) {
      zones.push({ type: 'supply', top: candle.high, bottom: candle.low, idx: i - 1, freshSince: candle.time });
    }
  }
  return zones;
}

function isZoneFresh(zone, bars4h) {
  // Fresh = no later bar's body has fully traded through it
  for (let i = zone.idx + 2; i < bars4h.length; i++) {
    const b = bars4h[i];
    const tradedThrough = zone.type === 'demand'
      ? b.close < zone.bottom
      : b.close > zone.top;
    if (tradedThrough) return false;
  }
  return true;
}

export function evaluate(ctx) {
  const pane60 = ctx.panesByTf.get('gold|60');
  const pane5 = ctx.panesByTf.get('gold|5');
  if (!pane60 || pane60.bars.length < 200) return [];
  const bars4h = to4h(pane60.bars);
  if (bars4h.length < 40) return [];
  const atr4h = atr(bars4h, 14);
  if (!atr4h) return [];
  const zones = findZones(bars4h, atr4h).filter((z) => isZoneFresh(z, bars4h));
  if (zones.length === 0) return [];

  const last5 = pane5?.bars?.[pane5.bars.length - 1] || pane60.bars[pane60.bars.length - 1];
  if (!last5) return [];
  const price = last5.close;

  // Find a zone that price is currently tapping into
  const tapped = zones.find((z) => price >= z.bottom && price <= z.top);
  if (!tapped) return [];

  // Displacement candle confirmation on 5m: most recent closed candle moved
  // ≥ 1 ATR(5m) in the direction we want
  const bars5 = pane5?.bars || [];
  if (bars5.length < 30) return [];
  const a5 = atr(bars5.slice(0, -1), 14);
  const c5 = bars5[bars5.length - 2]; // last CLOSED 5m candle
  const body = Math.abs(c5.close - c5.open);
  if (!a5 || body < a5) return [];
  const direction = tapped.type === 'demand' ? 'LONG' : 'SHORT';
  const goodDir = direction === 'LONG' ? c5.close > c5.open : c5.close < c5.open;
  if (!goodDir) return [];

  const entry = price;
  const stop = direction === 'LONG' ? tapped.bottom - 0.5 * a5 : tapped.top + 0.5 * a5;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  // Target: next HTF liquidity = previous swing extreme in trade direction
  const candidates = bars4h.slice(-30);
  let target;
  if (direction === 'LONG') {
    target = Math.max(...candidates.map((b) => b.high));
  } else {
    target = Math.min(...candidates.map((b) => b.low));
  }
  const t1 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const t2 = direction === 'LONG' ? Math.max(target, entry + 2.4 * risk) : Math.min(target, entry - 2.4 * risk);

  const { dateKey } = nyParts(last5.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, `${Math.round(tapped.top)}-${Math.round(tapped.bottom)}`),
    direction,
    setupName: `${NAME} — ${direction} mitigation of 4H ${tapped.type}`,
    summary: `4H ${tapped.type} zone $${tapped.bottom.toFixed(2)}–$${tapped.top.toFixed(2)} tapped; 5m displacement confirms.`,
    confidence: 0.78,
    timeframe: TF,
    entry, stop, t1, t2,
  })];
}
