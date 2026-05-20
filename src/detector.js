/**
 * Strategy orchestrator.
 *
 * Runs BOTH strategies each tick:
 *   - USLS (Universal Session Liquidity Sweep) — all sessions
 *   - ICT-NY-AM (Killzone strategy) — only 8:30-11:00 EST
 *
 * Each call returns an array of DetectorResult — the loop fires one alert
 * per result, deduped by setupId+status.
 *
 * @typedef {Object} DetectorResult
 * @property {string} strategy              'USLS' | 'ICT-NY-AM'
 * @property {string} setupId               stable identifier across lifecycle
 * @property {'forming'|'near_trigger'|'triggered'|'invalidated'} status
 * @property {string} direction             'LONG' | 'SHORT' | 'NONE'
 * @property {string} setupName             one-line title for Telegram
 * @property {string} summary               one-line body summary
 * @property {number} confidence            0..1
 * @property {Object} details               key-value pairs rendered in body
 * @property {number|null} invalidationLevel
 * @property {Object} [entryPlan]           on 'triggered' setups
 */

// TV CDP-based panes module is no longer required for data path — kept
// imported only because the drawings module depends on it.
// All 7 strategies imported. Each is gated by runtime-config.strategies[key]
// at invocation time, so the user can toggle any on/off via Octave.app.
import { evaluateUSLS } from './strategies/usls.js';
import { evaluateICTSMC } from './strategies/ict_smc.js';
import { evaluateAlgoSMC } from './strategies/algo_smc.js';
import { evaluateAdaptive } from './strategies/adaptive.js';
import { evaluateICTM15 } from './strategies/ict_m15.js';
import { evaluateSMTM15 } from './strategies/smt_m15.js';
import { evaluateTrinity } from './strategies/trinity.js';
import { nyParts } from './lib/time.js';
import { log } from './logger.js';
import { refresh as refreshConfig, isStrategyEnabled } from './lib/runtime_config.js';
import { fetchAllPanes, supplement as supplementWithCloudData } from './lib/cloud_data_supplement.js';

/** Build the unified context object all strategies consume. */
async function buildCtx() {
  // CLOUD-ONLY DATA PATH (per user directive: bot must always use cloud data).
  // Pulls full pane set from Yahoo Finance (with OANDA fallback). This means
  // the bot sees the FULL multi-TF picture (1m/5m/15m/60m/1D gold, 5m/15m
  // silver, 1D DXY) regardless of what — if anything — is loaded on the
  // user's TradingView chart. Cached 60s so the 3s detector loop is cheap.
  let panesByTf;
  try {
    panesByTf = await fetchAllPanes();
  } catch (err) {
    log.throttled('cloud-data-fail', 30000, () =>
      log.warn('cloud data fetch failed', { err: err.message })
    );
    panesByTf = new Map();
  }

  if (panesByTf.size === 0) {
    throw new Error('No cloud data available (Yahoo + OANDA both empty)');
  }

  // Note: TradingView Desktop is NOT consulted for bar data — Yahoo is the
  // authoritative source. TV is still used by the drawings module to render
  // levels on the user's active chart, but that path is independent of ctx.

  // Pick anchor: prefer execution TFs (5m / 1m / 15m), fall back to ANY gold pane.
  let anchor =
    panesByTf.get('gold|5') ||
    panesByTf.get('gold|1') ||
    panesByTf.get('gold|15') ||
    panesByTf.get('gold|60') ||
    panesByTf.get('gold|240') ||
    panesByTf.get('gold|D') ||
    panesByTf.get('gold|1D');
  if (!anchor) {
    // Last-ditch: pick any gold-keyed pane regardless of TF
    for (const [k, p] of panesByTf) {
      if (k.startsWith('gold|')) { anchor = p; break; }
    }
  }
  if (!anchor) {
    throw new Error('No gold pane found in cloud data response');
  }

  const lastBar = anchor.bars[anchor.bars.length - 1];
  const ts = Date.now();
  const np = nyParts(lastBar.time);

  return {
    ts,
    barTime: lastBar.time,
    lastClose: lastBar.close,
    panes: [...panesByTf.values()],
    panesByTf,
    anchorSymbol: anchor.symbol,
    anchorResolution: anchor.resolution,
    dateKey: np.dateKey,
    dataSource: 'cloud',
  };
}

export async function detect() {
  let ctx;
  try {
    ctx = await buildCtx();
  } catch (err) {
    log.throttled('detect-ctx-fail', 30000, () => log.warn('detect ctx build failed', { err: err.message }));
    return [];
  }

  // Refresh runtime config each tick so Octave-toggled changes take effect immediately
  refreshConfig();

  const results = [];
  const STRATEGY_TABLE = [
    ['USLS',      evaluateUSLS],
    ['ICT-SMC',   evaluateICTSMC],
    ['ALGO-SMC',  evaluateAlgoSMC],
    ['ADAPTIVE',  evaluateAdaptive],
    ['ICT',       evaluateICTM15],
    ['SMT',       evaluateSMTM15],
    ['TRINITY',   evaluateTrinity],
  ];
  for (const [name, fn] of STRATEGY_TABLE) {
    if (!isStrategyEnabled(name)) continue;
    try {
      results.push(...fn(ctx));
    } catch (err) {
      log.error(`${name} evaluator threw`, { err: err.message, stack: err.stack });
    }
  }

  // Attach context for the alerter
  for (const r of results) {
    r.symbol = ctx.anchorSymbol;
    r.timeframe = ctx.anchorResolution;
    r.lastClose = ctx.lastClose;
    r.barTime = ctx.barTime;
  }
  return results;
}
