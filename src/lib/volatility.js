/**
 * Volatility predictor — ATR + percentile rank + EWMA next-bar forecast.
 *
 * Categorical bucket for downstream consumers:
 *   low      — ATR percentile < 25
 *   normal   — 25 ≤ pct < 75
 *   elevated — 75 ≤ pct < 90
 *   extreme  — pct ≥ 90
 *
 * Forecast: EWMA of true-range with α = 0.1. This is a poor man's GARCH,
 * but it's adequate for a "what should I expect next bar" hint without
 * pulling in a stats library.
 */

const ATR_PERIOD = 14;
const FORECAST_ALPHA = 0.1;
const HISTORY_BARS = 100;

/**
 * @param {object} ctx
 * @param {string} [tf]
 * @returns {{ atr:number|null, atrPct:number|null, forecastNext:number|null,
 *             bucket:string, expandRatio:number|null, factors:string[] }}
 */
export function predictVolatility(ctx, tf = '15') {
  const pane = ctx?.pane?.(tf) || ctx?.pane?.('60') || ctx?.pane?.('5');
  const bars = pane?.bars;
  if (!bars || bars.length < ATR_PERIOD * 2) {
    return { atr: null, atrPct: null, forecastNext: null,
             bucket: 'undefined', expandRatio: null, factors: ['insufficient-bars'] };
  }

  const trSeries = trueRangeSeries(bars);
  const atrSeries = wilderAtrSeries(trSeries, ATR_PERIOD);
  const atr = atrSeries[atrSeries.length - 1];
  if (atr == null) {
    return { atr: null, atrPct: null, forecastNext: null,
             bucket: 'undefined', expandRatio: null, factors: ['atr-null'] };
  }

  // Percentile rank within last HISTORY_BARS atrs
  const recent = atrSeries.slice(-HISTORY_BARS).filter((v) => v != null);
  const atrPct = recent.length ? pctRank(recent, atr) : null;

  // EWMA forecast
  let ewma = trSeries[0] ?? atr;
  for (const tr of trSeries) ewma = FORECAST_ALPHA * tr + (1 - FORECAST_ALPHA) * ewma;
  const forecastNext = ewma;

  // Expansion ratio: latest TR vs ATR — > 1.5 means a vol expansion bar just printed
  const lastTr = trSeries[trSeries.length - 1];
  const expandRatio = atr === 0 ? null : lastTr / atr;

  const bucket =
    atrPct == null ? 'undefined' :
    atrPct < 0.25 ? 'low' :
    atrPct < 0.75 ? 'normal' :
    atrPct < 0.90 ? 'elevated' :
                    'extreme';

  const factors = [`ATR ${atr.toFixed(2)}`, `pct ${atrPct != null ? (atrPct * 100).toFixed(0) : '?'}`];
  if (expandRatio != null && expandRatio > 1.5) factors.push(`expansion ${expandRatio.toFixed(2)}x`);

  return { atr, atrPct, forecastNext, bucket, expandRatio, factors };
}

function trueRangeSeries(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    out.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return out;
}

function wilderAtrSeries(tr, period) {
  if (tr.length < period) return [];
  const out = new Array(period - 1).fill(null);
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(atr);
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out.push(atr);
  }
  return out;
}

function pctRank(series, value) {
  let below = 0;
  for (const v of series) if (v < value) below++;
  return below / series.length;
}
