/**
 * Strategy #4 — The Adaptive Gold Matrix
 *
 * Regime-aware: chooses one of 4 playbooks based on H1 ADX, gated by D1 macro bias.
 *
 *   Macro bias (Daily): DXY direction + Daily MACD (+ optional 10Y yields)
 *     - Bullish: DXY down + MACD positive (+ yields down if available)
 *     - Bearish: DXY up + MACD negative (+ yields up if available)
 *     - Neutral: anything else → only Range/Reversal playbook may fire
 *
 *   Regime (1H ADX):
 *     - < 25  → Range / Breakout-prep
 *     - 25-40 → Trend / Pullback
 *     - > 40  → Momentum / Reversal
 *
 *   Playbooks:
 *     A. Trend (ADX 25-40 + aligned macro): pullback to 20-EMA + rejection candle + RSI 40-60
 *     B. Range (ADX < 25): touch of recent range bound + RSI divergence
 *     C. Breakout (ADX transitioning < 25 → > 25): tight consolidation + 15m close outside + volume spike
 *     D. Gap (Sunday/Monday): handled descriptively only — needs weekend gap data we don't currently track
 *
 * Required panes:
 *   - Daily gold (for MACD)
 *   - 1H gold (for ADX, EMA20, RSI)
 *   - 15m gold (for execution / breakout pattern)
 *   - DXY pane (any TF, daily preferred)
 *
 * Optional panes:
 *   - 10Y yields (TNX, US10Y) — improves macro bias when present
 *   - Silver — already used by Strategy #3 for SMT; here we use GSR direction
 */

import { isMarketOpen, fmtNY, killzoneStatus } from '../lib/time.js';
import {
  atr,
} from '../lib/structure.js';
import {
  ema, emaLast, rsi, rsiLast, adx, macd,
  rejectionCandle, rsiDivergence, consolidationRange,
} from '../lib/indicators.js';
import { volumeSpike } from '../lib/structure.js';
import { checkBlackout } from '../lib/news.js';

const NAME = 'ADAPTIVE';
const LABEL = 'Strategy #4';

function findPaneByTfClass(ctx, kind) {
  const t = (k) => ctx.panesByTf.get(k);
  switch (kind) {
    case 'daily':    return t('gold|1D') || t('gold|D');
    case 'h1':       return t('gold|60');
    case 'm15':      return t('gold|15');
    case 'm5':       return t('gold|5');
    case 'dxy_d':    return t('dxy|1D') || t('dxy|D') || t('dxy|240') || t('dxy|60');
    case 'dxy_h1':   return t('dxy|60') || t('dxy|240') || t('dxy|15');
    case 'silver_d': return t('silver|1D') || t('silver|D') || t('silver|240') || t('silver|60');
  }
  return null;
}

// ---------- Macro bias ----------

function dxyDirection(dxyPane) {
  if (!dxyPane?.bars || dxyPane.bars.length < 5) return null;
  const last = dxyPane.bars[dxyPane.bars.length - 1].close;
  const ref = dxyPane.bars[dxyPane.bars.length - 5].close;
  if (last < ref * 0.999) return 'down';
  if (last > ref * 1.001) return 'up';
  return 'flat';
}

function computeMacroBias(ctx) {
  const daily = findPaneByTfClass(ctx, 'daily');
  const dxy = findPaneByTfClass(ctx, 'dxy_d');
  const reasons = [];
  const missing = [];

  if (!daily?.bars || daily.bars.length < 35) missing.push('daily gold');
  if (!dxy?.bars) missing.push('DXY');

  if (missing.length === 2) {
    return { bias: 'unknown', confidence: 0, reasons: ['no daily / no DXY pane'], missing };
  }

  let macdPos = null;
  if (daily?.bars && daily.bars.length >= 35) {
    const m = macd(daily.bars);
    if (m) {
      macdPos = m.hist > 0;
      reasons.push(`Daily MACD hist ${m.hist >= 0 ? '+' : ''}${m.hist.toFixed(2)}`);
    }
  }

  let dxyDir = null;
  if (dxy?.bars) {
    dxyDir = dxyDirection(dxy);
    reasons.push(`DXY ${dxyDir}`);
  }

  // Combine
  if (macdPos === true && dxyDir === 'down') {
    return { bias: 'bullish', confidence: 0.85, reasons, missing };
  }
  if (macdPos === false && dxyDir === 'up') {
    return { bias: 'bearish', confidence: 0.85, reasons, missing };
  }
  if (macdPos === true && dxyDir !== 'up') {
    return { bias: 'bullish', confidence: 0.55, reasons, missing };
  }
  if (macdPos === false && dxyDir !== 'down') {
    return { bias: 'bearish', confidence: 0.55, reasons, missing };
  }
  return { bias: 'neutral', confidence: 0.2, reasons, missing };
}

// ---------- Regime ----------

function classifyRegime(h1Pane) {
  if (!h1Pane?.bars || h1Pane.bars.length < 30) return { regime: 'unknown', adx: null };
  const a = adx(h1Pane.bars, 14);
  if (!a) return { regime: 'unknown', adx: null };
  if (a.adx < 25) return { regime: 'consolidating', adx: a };
  if (a.adx <= 40) return { regime: 'trending', adx: a };
  return { regime: 'overextended', adx: a };
}

// ---------- Playbook A: Trend (ADX 25-40 + aligned macro) ----------

function evalTrendPlaybook(ctx, h1Pane, regime, macro) {
  const out = [];
  if (regime.regime !== 'trending') return out;
  if (macro.bias === 'unknown' || macro.bias === 'neutral') return out;

  const bars = h1Pane.bars;
  const e20 = ema(bars, 20);
  const last = bars[bars.length - 1];
  const e20Last = e20[e20.length - 1];
  if (e20Last == null) return out;

  const direction = macro.bias === 'bullish' ? 'LONG' : 'SHORT';
  const wantedDir = macro.bias === 'bullish' ? 'bullish' : 'bearish';
  const a14 = atr(bars, 14) || 0;

  // Trigger: pullback to 20-EMA — last bar's range touches the EMA
  const touchedEma = last.low <= e20Last && last.high >= e20Last;
  if (!touchedEma) {
    // Forming: trend identified, awaiting pullback
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-trend-${direction}-await-pullback`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · TREND ${direction} — awaiting 20-EMA pullback`,
      summary: `Healthy trend (ADX ${regime.adx.adx.toFixed(1)}), ${macro.bias} bias. Waiting for pullback to 20-EMA @ ${e20Last.toFixed(2)}.`,
      confidence: 0.35,
      details: {
        'playbook': 'A: Trend',
        'regime': `trending (ADX ${regime.adx.adx.toFixed(1)})`,
        'macro bias': macro.bias,
        'macro reasons': macro.reasons.join(' · '),
        '20-EMA': e20Last.toFixed(2),
        'price': last.close.toFixed(2),
      },
      invalidationLevel: null,
      geometry: { target: { name: 'EMA20', level: e20Last, side: macro.bias === 'bullish' ? 'SSL' : 'BSL' } },
    }];
  }

  // Pullback touched. Look for rejection candle + RSI 40-60.
  const rej = rejectionCandle(bars, wantedDir);
  const rsiVal = rsiLast(bars, 14);
  const rsiOK = rsiVal != null && rsiVal >= 40 && rsiVal <= 60;

  if (!rej || !rsiOK) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-trend-${direction}-pullback`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · TREND ${direction} — pullback in progress`,
      summary: `At 20-EMA. ${rej ? 'Rejection candle ✓' : 'Rejection candle pending'}. ${rsiOK ? 'RSI ✓' : `RSI ${rsiVal?.toFixed(1)} outside 40-60`}.`,
      confidence: 0.55 + (rej ? 0.1 : 0) + (rsiOK ? 0.05 : 0),
      details: {
        'playbook': 'A: Trend',
        'regime': `trending (ADX ${regime.adx.adx.toFixed(1)})`,
        '20-EMA': e20Last.toFixed(2),
        'rejection': rej ? rej.kind : 'pending',
        'RSI': rsiVal != null ? rsiVal.toFixed(1) : '?',
      },
      invalidationLevel: direction === 'LONG' ? e20Last - 1.5 * a14 : e20Last + 1.5 * a14,
      geometry: { target: { name: 'EMA20', level: e20Last, side: direction === 'LONG' ? 'SSL' : 'BSL' } },
    }];
  }

  // Triggered
  const entry = last.close;
  const stop = direction === 'LONG' ? last.low - 1.5 * a14 : last.high + 1.5 * a14;
  const risk = Math.abs(entry - stop);
  const t1 = direction === 'LONG' ? entry + risk : entry - risk;
  const t2 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const runner = direction === 'LONG' ? entry + 3 * risk : entry - 3 * risk;

  out.push({
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-trend-${direction}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · TREND ${direction} TRIGGERED`,
    summary: `Trend pullback at 20-EMA confirmed. Entry ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} · TP2 ${t2.toFixed(2)}`,
    confidence: 0.78,
    details: {
      'playbook': 'A: Trend',
      'regime': `trending (ADX ${regime.adx.adx.toFixed(1)})`,
      'macro bias': `${macro.bias} (${(macro.confidence * 100).toFixed(0)}%)`,
      '20-EMA': e20Last.toFixed(2),
      'rejection': rej.kind,
      'RSI': rsiVal.toFixed(1),
      'ATR(14)': a14.toFixed(2),
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner, risk },
    geometry: {
      target: { name: 'EMA20', level: e20Last, side: direction === 'LONG' ? 'SSL' : 'BSL' },
      entryPlan: { direction, entry, stop, t1, t2, runner },
    },
  });
  return out;
}

// ---------- Playbook B: Range / Reversal (ADX < 25 or ADX > 40) ----------

function evalRangePlaybook(ctx, h1Pane, regime) {
  const out = [];
  if (regime.regime !== 'consolidating' && regime.regime !== 'overextended') return out;
  const bars = h1Pane.bars;
  const window = bars.slice(-24); // last 24h on H1
  let top = -Infinity, bot = Infinity;
  for (const b of window) { top = Math.max(top, b.high); bot = Math.min(bot, b.low); }
  const last = bars[bars.length - 1];
  const mid = (top + bot) / 2;
  const a14 = atr(bars, 14) || 0;
  const divs = rsiDivergence(bars, 3, 14);

  // Bearish reversal at top
  const nearTop = last.high >= top - 0.3 * a14;
  const nearBot = last.low <= bot + 0.3 * a14;
  if (nearTop && divs?.bearish) {
    const entry = last.close;
    const stop = top + 1.5 * a14;
    const risk = stop - entry;
    const t1 = entry - risk;
    const t2 = mid;
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-range-SHORT-trig`,
      status: 'triggered',
      direction: 'SHORT',
      setupName: `${LABEL} · RANGE SHORT TRIGGERED (RSI divergence at top)`,
      summary: `Range top tagged. Bearish RSI divergence ${divs.bearish.rsiFrom.toFixed(0)}→${divs.bearish.rsiTo.toFixed(0)}. Fade to mid ${mid.toFixed(2)}.`,
      confidence: 0.7 + (regime.regime === 'overextended' ? 0.05 : 0),
      details: {
        'playbook': 'B: Range/Reversal',
        'regime': `${regime.regime} (ADX ${regime.adx.adx.toFixed(1)})`,
        'range': `${bot.toFixed(2)} - ${top.toFixed(2)}`,
        'RSI divergence': `${divs.bearish.rsiFrom.toFixed(0)} → ${divs.bearish.rsiTo.toFixed(0)}`,
      },
      invalidationLevel: stop,
      entryPlan: { direction: 'SHORT', entry, stop, t1, t2, risk },
      geometry: {
        target: { name: 'Range-Top', level: top, side: 'BSL' },
        entryPlan: { direction: 'SHORT', entry, stop, t1, t2 },
      },
    });
  } else if (nearBot && divs?.bullish) {
    const entry = last.close;
    const stop = bot - 1.5 * a14;
    const risk = entry - stop;
    const t1 = entry + risk;
    const t2 = mid;
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-range-LONG-trig`,
      status: 'triggered',
      direction: 'LONG',
      setupName: `${LABEL} · RANGE LONG TRIGGERED (RSI divergence at bottom)`,
      summary: `Range bottom tagged. Bullish RSI divergence ${divs.bullish.rsiFrom.toFixed(0)}→${divs.bullish.rsiTo.toFixed(0)}. Fade to mid ${mid.toFixed(2)}.`,
      confidence: 0.7 + (regime.regime === 'overextended' ? 0.05 : 0),
      details: {
        'playbook': 'B: Range/Reversal',
        'regime': `${regime.regime} (ADX ${regime.adx.adx.toFixed(1)})`,
        'range': `${bot.toFixed(2)} - ${top.toFixed(2)}`,
        'RSI divergence': `${divs.bullish.rsiFrom.toFixed(0)} → ${divs.bullish.rsiTo.toFixed(0)}`,
      },
      invalidationLevel: stop,
      entryPlan: { direction: 'LONG', entry, stop, t1, t2, risk },
      geometry: {
        target: { name: 'Range-Bot', level: bot, side: 'SSL' },
        entryPlan: { direction: 'LONG', entry, stop, t1, t2 },
      },
    });
  } else if (nearTop || nearBot) {
    // Forming
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-range-${nearTop ? 'top' : 'bot'}-approaching`,
      status: 'forming',
      direction: nearTop ? 'SHORT' : 'LONG',
      setupName: `${LABEL} · RANGE — at ${nearTop ? 'top' : 'bottom'}, awaiting RSI divergence`,
      summary: `${regime.regime} regime. Range ${bot.toFixed(2)}-${top.toFixed(2)}. Touched ${nearTop ? 'top' : 'bottom'}. No divergence yet.`,
      confidence: 0.35,
      details: {
        'playbook': 'B: Range',
        'regime': `${regime.regime} (ADX ${regime.adx.adx.toFixed(1)})`,
        'range': `${bot.toFixed(2)} - ${top.toFixed(2)}`,
      },
      invalidationLevel: nearTop ? top + 1.5 * a14 : bot - 1.5 * a14,
      geometry: { target: { name: nearTop ? 'Range-Top' : 'Range-Bot', level: nearTop ? top : bot, side: nearTop ? 'BSL' : 'SSL' } },
    });
  }
  return out;
}

// ---------- Playbook C: Breakout (consolidating → trending transition) ----------

function evalBreakoutPlaybook(ctx, m15Pane, regime, macro) {
  const out = [];
  if (regime.regime !== 'consolidating') return out;
  if (!m15Pane?.bars || m15Pane.bars.length < 30) return out;
  const cons = consolidationRange(m15Pane.bars, 12);
  if (!cons || cons.ratio > 2.5) return out;

  const last = m15Pane.bars[m15Pane.bars.length - 1];
  const vol = volumeSpike(m15Pane.bars, 1.5, 20);
  const broke = last.close > cons.top ? 'up' : last.close < cons.bottom ? 'down' : null;

  if (!broke) {
    // Forming: tight box, waiting for breakout
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-breakout-coil`,
      status: 'forming',
      direction: macro.bias === 'bullish' ? 'LONG' : macro.bias === 'bearish' ? 'SHORT' : 'NONE',
      setupName: `${LABEL} · BREAKOUT — coil tightening`,
      summary: `Tight box on 15m (${cons.height.toFixed(2)} range, ${cons.ratio.toFixed(2)}× ATR). Awaiting close outside ${cons.bottom.toFixed(2)}-${cons.top.toFixed(2)}.`,
      confidence: 0.3,
      details: {
        'playbook': 'C: Breakout',
        'regime': `consolidating (ADX ${regime.adx.adx.toFixed(1)})`,
        'box': `${cons.bottom.toFixed(2)} - ${cons.top.toFixed(2)}`,
        'box/ATR': cons.ratio.toFixed(2),
      },
      invalidationLevel: null,
      geometry: { target: { name: 'Box-Top', level: cons.top, side: 'BSL' } },
    }];
  }

  // Direction must align with macro bias (per spec)
  const direction = broke === 'up' ? 'LONG' : 'SHORT';
  const aligned = (broke === 'up' && macro.bias === 'bullish') || (broke === 'down' && macro.bias === 'bearish');
  if (!aligned) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-breakout-${broke}-misaligned`,
      status: 'invalidated',
      direction,
      setupName: `${LABEL} · BREAKOUT ${broke.toUpperCase()} INVALIDATED (vs macro)`,
      summary: `15m closed ${broke} of box but macro bias is ${macro.bias}. Spec rejects misaligned breakouts.`,
      confidence: 0,
      details: { 'playbook': 'C: Breakout', 'broke': broke, 'macro bias': macro.bias },
      invalidationLevel: null,
    }];
  }
  const volOK = vol === null || vol.spike;
  if (!volOK) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-breakout-${broke}-low-vol`,
      status: 'invalidated',
      direction,
      setupName: `${LABEL} · BREAKOUT ${direction} INVALIDATED (no volume)`,
      summary: `Breakout without volume spike (${vol.ratio.toFixed(2)}×). Spec calls this a fakeout.`,
      confidence: 0,
      details: { 'playbook': 'C: Breakout', 'volume': `${vol.ratio.toFixed(2)}×` },
      invalidationLevel: null,
    }];
  }

  const a14h1 = atr(m15Pane.bars, 14) || 0;
  const entry = last.close;
  const stop = direction === 'LONG' ? cons.bottom - a14h1 * 0.5 : cons.top + a14h1 * 0.5;
  const risk = Math.abs(entry - stop);
  const t1 = direction === 'LONG' ? entry + risk : entry - risk;
  const t2 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  out.push({
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-breakout-${direction}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · BREAKOUT ${direction} TRIGGERED`,
    summary: `15m close ${broke} of ${cons.bottom.toFixed(2)}-${cons.top.toFixed(2)} with volume. Aligned with macro ${macro.bias}.`,
    confidence: 0.78 + (vol && vol.ratio >= 2 ? 0.05 : 0),
    details: {
      'playbook': 'C: Breakout',
      'box': `${cons.bottom.toFixed(2)} - ${cons.top.toFixed(2)}`,
      'volume': vol === null ? 'unavailable' : `${vol.ratio.toFixed(2)}×`,
      'macro bias': macro.bias,
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, risk },
    geometry: {
      target: { name: broke === 'up' ? 'Box-Top' : 'Box-Bot', level: broke === 'up' ? cons.top : cons.bottom, side: broke === 'up' ? 'BSL' : 'SSL' },
      entryPlan: { direction, entry, stop, t1, t2 },
    },
  });
  return out;
}

// ---------- Top-level evaluator ----------

export function evaluateAdaptive(ctx) {
  // Gold-only: macro bias is built from DXY's inverse correlation to gold.
  // Equity indexes have different macro drivers; needs a separate model.
  if (ctx.instrument !== 'gold') return [];
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];

  // News blackout for Trend + Breakout (per spec); Range/Reversal still allowed
  const black = checkBlackout(now, 30);

  const h1 = findPaneByTfClass(ctx, 'h1');
  if (!h1 || !h1.bars || h1.bars.length < 30) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-h1`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 1H gold pane`,
      summary: 'Strategy #4 needs a 1H gold pane for ADX regime detection.',
      confidence: 0,
      details: { 'phase': 'state 0 — no H1 data' },
      invalidationLevel: null,
    }];
  }

  const macro = computeMacroBias(ctx);
  const regime = classifyRegime(h1);
  if (regime.regime === 'unknown') return [];

  const m15 = findPaneByTfClass(ctx, 'm15');
  const out = [];

  // Trend playbook (skips during news blackout per spec)
  if (!black.blocked) out.push(...evalTrendPlaybook(ctx, h1, regime, macro));
  // Range/Reversal (allowed during news per spec)
  out.push(...evalRangePlaybook(ctx, h1, regime));
  // Breakout (skips during news blackout per spec)
  if (!black.blocked) out.push(...evalBreakoutPlaybook(ctx, m15 || h1, regime, macro));

  // Always attach regime/macro context to each result
  for (const r of out) {
    r.details = r.details || {};
    if (!r.details.regime) r.details.regime = `${regime.regime} (ADX ${regime.adx?.adx?.toFixed(1)})`;
    if (!r.details['macro bias']) r.details['macro bias'] = `${macro.bias} (${(macro.confidence * 100).toFixed(0)}%)`;
  }

  return out;
}
