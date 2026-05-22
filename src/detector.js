/**
 * Strategy orchestrator — multi-instrument, registry-driven.
 *
 * Loops every enabled strategy across each instrument [gold, nasdaq, sp].
 * Strategies are auto-discovered from src/strategies/ — see strategy_registry.js.
 *
 * @typedef {Object} DetectorResult
 * @property {string} strategy        strategy id (matches meta.id)
 * @property {string} instrument      'gold' | 'nasdaq' | 'sp'
 * @property {string} setupId         stable id across lifecycle
 * @property {'forming'|'near_trigger'|'triggered'|'invalidated'} status
 * @property {string} direction       'LONG' | 'SHORT' | 'NONE'
 * @property {string} setupName
 * @property {string} summary
 * @property {number} confidence      0..1
 * @property {string|number} timeframe
 * @property {Object} [entryPlan]     { entry, stop, t1, t2, risk } on triggered
 * @property {Array<string>} [confirmations]  bullet list shown in alerts
 */

import { nyParts } from './lib/time.js';
import { log } from './logger.js';
import { refresh as refreshConfig, isStrategyEnabled } from './lib/runtime_config.js';
import { fetchAllPanes } from './lib/cloud_data_supplement.js';
import { checkBlackout, refreshForexFactory } from './lib/news.js';
import { evaluateUserStrategies } from './lib/user_strategies.js';
import { enrichSetup } from './lib/trade_enrichment.js';
import { loadRegistry } from './lib/strategy_registry.js';

// Three primary instruments. Each runs the full strategy gauntlet; strategies
// can opt out by declaring `meta.instruments`.
export const INSTRUMENTS = ['gold', 'nasdaq', 'sp'];

export const INSTRUMENT_META = {
  gold:   { label: 'Gold',   symbol: 'MGC1!', tvFullSymbol: 'COMEX:MGC1!' },
  nasdaq: { label: 'Nasdaq', symbol: 'MNQ1!', tvFullSymbol: 'CME_MINI:MNQ1!' },
  sp:     { label: 'S&P',    symbol: 'MES1!', tvFullSymbol: 'CME_MINI:MES1!' },
};

function buildInstrumentCtx(instrument, panesByTf) {
  // Anchor on 15m of this instrument; fall back through 60/5/1/D.
  const candidates = ['15', '60', '5', '1', '240', '1D', 'D'];
  let anchor = null;
  for (const tf of candidates) {
    const p = panesByTf.get(`${instrument}|${tf}`);
    if (p?.bars?.length) { anchor = p; break; }
  }
  if (!anchor) return null;

  const lastBar = anchor.bars[anchor.bars.length - 1];
  const np = nyParts(lastBar.time);

  const ctx = {
    instrument,
    ts: Date.now(),
    barTime: lastBar.time,
    lastClose: lastBar.close,
    panes: [...panesByTf.values()],
    panesByTf,
    anchorSymbol: INSTRUMENT_META[instrument].symbol,
    anchorResolution: anchor.resolution,
    dateKey: np.dateKey,
    dataSource: 'cloud',
  };
  // ctx.pane(tf) returns THIS instrument's pane at the requested TF.
  // Cross-asset strategies still reach into ctx.panesByTf.get('silver|15') etc.
  ctx.pane = (tf) => panesByTf.get(`${instrument}|${tf}`);
  return ctx;
}

export async function detect() {
  let panesByTf;
  try {
    panesByTf = await fetchAllPanes();
  } catch (err) {
    log.throttled('cloud-data-fail', 30000, () =>
      log.warn('cloud data fetch failed', { err: err.message }));
    return [];
  }
  if (panesByTf.size === 0) return [];

  refreshConfig();
  refreshForexFactory().catch(() => {});
  const blackout = checkBlackout(Date.now() / 1000, 30);

  const registry = await loadRegistry();
  const allResults = [];

  for (const instrument of INSTRUMENTS) {
    const ctx = buildInstrumentCtx(instrument, panesByTf);
    if (!ctx) continue;

    const results = [];
    for (const s of registry) {
      if (!isStrategyEnabled(s.id)) continue;
      if (!s.instruments.includes(instrument)) continue;
      try { results.push(...s.evaluate(ctx)); }
      catch (err) {
        log.error('strategy evaluator threw', { strategy: s.id, instrument, err: err.message, stack: err.stack });
      }
    }
    try { results.push(...evaluateUserStrategies(ctx, isStrategyEnabled)); }
    catch (err) { log.error('user strategies threw', { instrument, err: err.message, stack: err.stack }); }

    for (const r of results) {
      r.instrument = instrument;
      r.symbol = ctx.anchorSymbol;
      if (!r.timeframe) r.timeframe = ctx.anchorResolution;
      r.lastClose = ctx.lastClose;
      r.barTime = ctx.barTime;
      if (!r.setupId.startsWith(`${instrument}|`)) r.setupId = `${instrument}|${r.setupId}`;
      if (r.status === 'triggered') {
        try { r.enrichment = enrichSetup(r, ctx); }
        catch (err) { log.warn('enrichSetup threw', { setupId: r.setupId, err: err.message }); }
      }
    }
    allResults.push(...results);
  }

  // 15m+ gate — strategies emitting on 5m/1m don't reach the user.
  const TF_MIN = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, 'D': 1440, '1D': 1440, 'W': 10080 };
  const filtered = allResults.filter((r) => (TF_MIN[String(r.timeframe)] || 0) >= 15);

  // News blackout: soft-block triggered setups ±30m of high-impact events.
  if (blackout.blocked) {
    for (const r of filtered) {
      if (r.status === 'triggered') {
        r.status = 'invalidated';
        r.invalidReason = `news blackout: ${blackout.event?.title || 'high-impact event'} ±30m`;
      }
    }
  }
  return filtered;
}
