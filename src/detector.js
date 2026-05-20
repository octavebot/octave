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

import { snapshotAllPanes, indexPanesBySymTf } from './lib/panes.js';
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
import { supplement as supplementWithCloudData } from './lib/cloud_data_supplement.js';

/** Build the unified context object all strategies consume. */
async function buildCtx() {
  const panes = await snapshotAllPanes(300);
  // Build symbolic lookup: "gold|<res>" -> pane and "dxy|<res>" -> pane.
  // Both micro (MGC1!) and standard (GC1!) gold are accepted.
  const panesByTf = new Map();
  for (const p of panes) {
    if (p.error || !p.bars) continue;
    const sym = String(p.symbol || '').toUpperCase();
    const res = String(p.resolution);
    if (/GC1|MGC1|XAU|GOLD|GCJ|GCM|GCN|GCQ|GCV|GCZ|GCG/i.test(sym)) {
      panesByTf.set(`gold|${res}`, p);
    }
    if (/DXY|US Dollar Index|TVC:DXY|USDOLLAR/i.test(sym)) {
      panesByTf.set(`dxy|${res}`, p);
    }
    if (/XAG|SI1!|^SI$|SILVER|SIL_|MSI1/i.test(sym)) {
      panesByTf.set(`silver|${res}`, p);
    }
  }

  // Supplement missing panes with Yahoo-fetched data (cached 5min).
  // This lets strategies like SMT and Trinity work even if the user only has
  // a single pane open in TradingView.
  try {
    await supplementWithCloudData(panesByTf);
  } catch (err) {
    log.throttled('supplement-fail', 5 * 60 * 1000, () =>
      log.warn('cloud data supplement failed', { err: err.message })
    );
  }

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
    throw new Error('No gold pane found in TradingView layout');
  }

  const lastBar = anchor.bars[anchor.bars.length - 1];
  const ts = Date.now();
  const np = nyParts(lastBar.time);

  return {
    ts,
    barTime: lastBar.time,
    lastClose: lastBar.close,
    panes,
    panesByTf,
    anchorSymbol: anchor.symbol,
    anchorResolution: anchor.resolution,
    dateKey: np.dateKey,
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
