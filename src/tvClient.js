// tradingview-mcp is a local file:// dependency that only exists on the
// developer's Mac (where TradingView Desktop runs with CDP enabled). On a
// VPS / Linux server the package isn't installed — but the rest of Octave
// (cloud data, alerts, dashboard) must still work. So this module loads
// tradingview-mcp lazily and degrades gracefully when it's missing.

let _chart = null;
let _data = null;
let _loadAttempted = false;
let _available = false;

async function loadMcp() {
  if (_loadAttempted) return _available;
  _loadAttempted = true;
  try {
    const m = await import('tradingview-mcp/core');
    _chart = m.chart;
    _data = m.data;
    _available = true;
  } catch {
    // Expected on VPS — tradingview-mcp is a Mac-dev-only dependency.
    // Silent: no TV-dependent code path runs without first checking isAvailable().
    _available = false;
  }
  return _available;
}

export function isAvailable() { return _available; }

/**
 * Quick connection check. Returns true if TV/CDP responds.
 */
export async function pingCDP() {
  if (!(await loadMcp())) return false;
  try {
    await _chart.getState();
    return true;
  } catch {
    return false;
  }
}

/**
 * One snapshot of chart state. Returns null when tradingview-mcp is missing
 * or TV isn't reachable — callers must tolerate this.
 */
export async function snapshot() {
  if (!(await loadMcp())) return null;
  try {
    const state = await _chart.getState();
    const [studyValues, ohlcvSummary, lastBar] = await Promise.all([
      _data.getStudyValues().catch(() => ({ studies: [] })),
      _data.getOhlcv({ summary: true }).catch(() => null),
      _data.getOhlcv({ count: 1, summary: false }).catch(() => null),
    ]);

    const barTime = lastBar?.bars?.[0]?.time ?? null;
    const lastClose = lastBar?.bars?.[0]?.close ?? null;

    return {
      ts: Date.now(),
      symbol: state.symbol,
      timeframe: state.resolution,
      chartType: state.chartType,
      studies: state.studies || [],
      studyValues: studyValues.studies || [],
      ohlcvSummary,
      barTime,
      lastClose,
    };
  } catch (err) {
    console.warn('[tvClient] snapshot failed:', err.message);
    return null;
  }
}

/**
 * Opt-in Pine graphics pull for detectors that need indicator drawings.
 */
export async function snapshotPine(opts = {}) {
  if (!(await loadMcp())) return {};
  try {
    const filter = opts.filter || '';
    const out = {};
    const ops = [];
    if (opts.lines)  ops.push(['lines',  _data.getPineLines({ study_filter: filter })]);
    if (opts.labels) ops.push(['labels', _data.getPineLabels({ study_filter: filter })]);
    if (opts.tables) ops.push(['tables', _data.getPineTables({ study_filter: filter })]);
    if (opts.boxes)  ops.push(['boxes',  _data.getPineBoxes({ study_filter: filter })]);
    await Promise.all(ops.map(async ([k, p]) => { out[k] = await p.catch(() => null); }));
    return out;
  } catch (err) {
    console.warn('[tvClient] snapshotPine failed:', err.message);
    return {};
  }
}
