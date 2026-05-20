/**
 * Multi-pane data accessor — reads OHLCV from every pane in the user's
 * TradingView layout in a single CDP roundtrip.
 *
 * Returns one record per pane: { index, symbol, resolution, bars, lastClose, active }
 * Bars are { time, open, high, low, close, volume }, ascending.
 */

// Lazy-load tradingview-mcp so this module imports cleanly on the VPS where
// the package isn't installed. The exported functions return empty/null when
// the dependency is missing — callers must already tolerate empty pane sets.
let _evaluate = null;
let _loadAttempted = false;
async function evaluate(...args) {
  if (!_loadAttempted) {
    _loadAttempted = true;
    try {
      const m = await import('tradingview-mcp/connection');
      _evaluate = m.evaluate;
    } catch (err) {
      console.warn('[panes] tradingview-mcp not installed — TV CDP reads disabled');
      _evaluate = null;
    }
  }
  if (!_evaluate) return null;
  return _evaluate(...args);
}

const SCRIPT = (limit) => `
  (function() {
    var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    if (!cwc || typeof cwc.getAll !== 'function') return { error: 'chartWidgetCollection unavailable' };
    var charts = cwc.getAll();
    var results = [];
    var activeChart = window.TradingViewApi._activeChartWidgetWV
      ? window.TradingViewApi._activeChartWidgetWV.value()
      : null;
    var activeChartWidget = activeChart ? activeChart._chartWidget : null;
    for (var i = 0; i < charts.length; i++) {
      try {
        var c = charts[i];
        var model = c.model ? c.model() : null;
        if (!model) { results.push({ index: i, error: 'no model' }); continue; }
        var mainSeries = model.mainSeries();
        var sym = mainSeries.symbol();
        var res = mainSeries.interval ? mainSeries.interval() : (mainSeries.resolution ? mainSeries.resolution() : null);
        var barsObj = mainSeries.bars();
        if (!barsObj || typeof barsObj.lastIndex !== 'function') {
          results.push({ index: i, symbol: sym, resolution: res, error: 'bars unavailable' });
          continue;
        }
        var sz = barsObj.size();
        var end = barsObj.lastIndex();
        var start = Math.max(barsObj.firstIndex(), end - ${limit} + 1);
        var bars = [];
        for (var idx = start; idx <= end; idx++) {
          var v = barsObj.valueAt(idx);
          if (v) bars.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
        }
        results.push({
          index: i,
          symbol: sym,
          resolution: res,
          totalBars: sz,
          bars: bars,
          barCount: bars.length,
          active: (activeChartWidget && c === activeChartWidget) ? true : false,
        });
      } catch (e) {
        results.push({ index: i, error: String(e && e.message || e) });
      }
    }
    return { panes: results };
  })()
`;

/**
 * @param {number} barLimit max bars per pane (default 300)
 */
export async function snapshotAllPanes(barLimit = 300) {
  const limit = Math.max(50, Math.min(800, barLimit));
  const out = await evaluate(SCRIPT(limit));
  if (!out) return []; // tradingview-mcp not installed (e.g., VPS) → no panes
  if (out.error) {
    throw new Error(`pane snapshot failed: ${out.error}`);
  }
  return out.panes;
}

/**
 * Convenience: build a map keyed by symbol+resolution for downstream lookup.
 * If multiple panes have the same symbol+resolution, the active one wins,
 * else the first one wins.
 */
export function indexPanesBySymTf(panes) {
  const map = new Map();
  for (const p of panes) {
    if (p.error || !p.bars) continue;
    const key = `${p.symbol}|${p.resolution}`;
    const existing = map.get(key);
    if (!existing || p.active) map.set(key, p);
  }
  return map;
}

/**
 * Find the gold pane on a target resolution (e.g. '15', '5', '1', '60', '240', 'D').
 * Looks for any pane whose symbol contains GC or XAU and resolution matches.
 */
export function findGoldPane(panes, resolution) {
  return panes.find(
    (p) =>
      !p.error &&
      p.resolution === String(resolution) &&
      /GC|XAU|GOLD/i.test(String(p.symbol || ''))
  );
}

/**
 * Find a DXY-correlated pane on a target resolution.
 */
export function findDxyPane(panes, resolution) {
  return panes.find(
    (p) =>
      !p.error &&
      p.resolution === String(resolution) &&
      /DXY|DX|USDOLLAR|US Dollar Index/i.test(String(p.symbol || ''))
  );
}

/**
 * Find a Silver pane (XAGUSD / SI1! / SIL) on a target resolution.
 * Used by Strategy #3's SMT correlation check.
 */
export function findSilverPane(panes, resolution) {
  return panes.find(
    (p) =>
      !p.error &&
      p.resolution === String(resolution) &&
      /XAG|SI1!|SIL[A-Z]?|SIL_|^SI$|SILVER/i.test(String(p.symbol || ''))
  );
}
