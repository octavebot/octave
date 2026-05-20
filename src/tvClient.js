import { chart, data } from 'tradingview-mcp/core';

/**
 * Quick connection check. Returns true if TV/CDP responds.
 * The MCP's getClient() singleton already self-heals via a liveness probe,
 * so we just call a cheap operation and catch.
 */
export async function pingCDP() {
  try {
    await chart.getState();
    return true;
  } catch {
    return false;
  }
}

/**
 * One snapshot of chart state for the detector to inspect.
 * Kept lightweight — no Pine graphics pulls unless the detector asks via snapshotPine().
 */
export async function snapshot() {
  const state = await chart.getState();
  const [studyValues, ohlcvSummary, lastBar] = await Promise.all([
    data.getStudyValues().catch(() => ({ studies: [] })),
    data.getOhlcv({ summary: true }).catch(() => null),
    data.getOhlcv({ count: 1, summary: false }).catch(() => null),
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
}

/**
 * Opt-in Pine graphics pull for detectors that need indicator drawings.
 * @param {{lines?: boolean, labels?: boolean, tables?: boolean, boxes?: boolean, filter?: string}} opts
 */
export async function snapshotPine(opts = {}) {
  const filter = opts.filter || '';
  const out = {};
  const ops = [];
  if (opts.lines) ops.push(['lines', data.getPineLines({ study_filter: filter })]);
  if (opts.labels) ops.push(['labels', data.getPineLabels({ study_filter: filter })]);
  if (opts.tables) ops.push(['tables', data.getPineTables({ study_filter: filter })]);
  if (opts.boxes) ops.push(['boxes', data.getPineBoxes({ study_filter: filter })]);
  await Promise.all(ops.map(async ([k, p]) => { out[k] = await p.catch(() => null); }));
  return out;
}
