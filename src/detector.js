/**
 * Strategy orchestrator — multi-instrument.
 *
 * Runs every enabled strategy across each of [gold, nasdaq, sp] on each tick.
 * Strategies that depend on cross-asset data (Gold/Silver SMT, DXY-driven gold
 * bias) declare themselves gold-only and short-circuit when ctx.instrument !==
 * 'gold'.
 *
 * @typedef {Object} DetectorResult
 * @property {string} strategy
 * @property {string} instrument            'gold' | 'nasdaq' | 'sp'
 * @property {string} setupId               stable identifier across lifecycle
 * @property {'forming'|'near_trigger'|'triggered'|'invalidated'} status
 * @property {string} direction             'LONG' | 'SHORT' | 'NONE'
 * @property {string} setupName
 * @property {string} summary
 * @property {number} confidence            0..1
 * @property {Object} details
 * @property {number|null} invalidationLevel
 * @property {Object} [entryPlan]           on 'triggered' setups
 */

import { evaluateUSLS } from './strategies/usls.js';
import { evaluateICTSMC } from './strategies/ict_smc.js';
import { evaluateAlgoSMC } from './strategies/algo_smc.js';
import { evaluateAdaptive } from './strategies/adaptive.js';
import { evaluateICTM15 } from './strategies/ict_m15.js';
import { evaluateSMTM15 } from './strategies/smt_m15.js';
import { evaluateTrinity } from './strategies/trinity.js';
import { evaluateAMN } from './strategies/amn.js';
import { evaluateTORI } from './strategies/tori.js';
import { evaluateWARRIOR } from './strategies/warrior.js';
import { nyParts } from './lib/time.js';
import { log } from './logger.js';
import { refresh as refreshConfig, isStrategyEnabled } from './lib/runtime_config.js';
import { fetchAllPanes } from './lib/cloud_data_supplement.js';
import { checkBlackout, refreshForexFactory } from './lib/news.js';
import { evaluateChatgptPack } from './strategies/chatgpt/index.js';
import { evaluateGeminiPack } from './strategies/gemini/index.js';
import { evaluateUserStrategies } from './lib/user_strategies.js';

// Three primary instruments. Each runs the full strategy gauntlet; gold-only
// strategies skip themselves via ctx.instrument check.
export const INSTRUMENTS = ['gold', 'nasdaq', 'sp'];

// Pretty labels used in alerts + dashboards. Symbol matches TV ticker for
// micro-futures (what the user actually trades on prop accounts).
export const INSTRUMENT_META = {
  gold:   { label: 'Gold',   symbol: 'MGC1!', tvFullSymbol: 'COMEX:MGC1!' },
  nasdaq: { label: 'Nasdaq', symbol: 'MNQ1!', tvFullSymbol: 'CME_MINI:MNQ1!' },
  sp:     { label: 'S&P',    symbol: 'MES1!', tvFullSymbol: 'CME_MINI:MES1!' },
};

/**
 * Build a per-instrument context. panesByTf retains the instrument-prefixed
 * keys ('gold|15', 'silver|15', 'dxy|1D') so cross-asset strategies can still
 * reach for their referenced asset; the `ctx.pane(tf)` helper returns this
 * instrument's pane at the requested TF — that's the path universal strategies
 * use to stay instrument-agnostic.
 */
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
  // `ctx.pane(tf)` — the canonical accessor for THIS instrument's pane at TF.
  // Universal strategies call this; cross-asset strategies still reach into
  // ctx.panesByTf.get('silver|15') etc. directly.
  ctx.pane = (tf) => panesByTf.get(`${instrument}|${tf}`);
  return ctx;
}

export async function detect() {
  // Single shared fetch — same Map handed to all three instrument ctxs.
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

  const STRATEGY_TABLE = [
    ['USLS',      evaluateUSLS],
    ['ICT-SMC',   evaluateICTSMC],
    ['ALGO-SMC',  evaluateAlgoSMC],
    ['ADAPTIVE',  evaluateAdaptive],
    ['ICT',       evaluateICTM15],
    ['SMT',       evaluateSMTM15],
    ['TRINITY',   evaluateTrinity],
    ['AMN',       evaluateAMN],
    ['TORI',      evaluateTORI],
    ['WARRIOR',   evaluateWARRIOR],
  ];

  const allResults = [];
  for (const instrument of INSTRUMENTS) {
    const ctx = buildInstrumentCtx(instrument, panesByTf);
    if (!ctx) continue;

    const results = [];
    for (const [name, fn] of STRATEGY_TABLE) {
      if (!isStrategyEnabled(name)) continue;
      try { results.push(...fn(ctx)); }
      catch (err) { log.error(`${name} evaluator threw`, { instrument, err: err.message, stack: err.stack }); }
    }
    try { results.push(...evaluateChatgptPack(ctx)); }
    catch (err) { log.error('chatgpt pack threw', { instrument, err: err.message, stack: err.stack }); }
    try { results.push(...evaluateGeminiPack(ctx)); }
    catch (err) { log.error('gemini pack threw', { instrument, err: err.message, stack: err.stack }); }
    try { results.push(...evaluateUserStrategies(ctx, isStrategyEnabled)); }
    catch (err) { log.error('user strategies threw', { instrument, err: err.message, stack: err.stack }); }

    // Stamp every result with the instrument it came from + per-instrument
    // anchor metadata. setupId is namespaced with the instrument prefix so
    // dedup works across all three.
    for (const r of results) {
      r.instrument = instrument;
      r.symbol = ctx.anchorSymbol;
      if (!r.timeframe) r.timeframe = ctx.anchorResolution;
      r.lastClose = ctx.lastClose;
      r.barTime = ctx.barTime;
      // Namespace setupId so identical USLS setupId on gold + nasdaq doesn't collide.
      if (!r.setupId.startsWith(`${instrument}|`)) r.setupId = `${instrument}|${r.setupId}`;
    }
    allResults.push(...results);
  }

  // 15m+ gate — strategies that emit on 5m/1m never reach the user.
  const TF_MINUTES = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, 'D': 1440, '1D': 1440, 'W': 10080 };
  const filtered = allResults.filter((r) => (TF_MINUTES[String(r.timeframe)] || 0) >= 15);

  // News blackout — soft-block triggered setups so no Telegram fires within
  // ±30m of a high-impact event. (Forming/near_trigger continue so /bias still
  // reflects what would have happened.)
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
