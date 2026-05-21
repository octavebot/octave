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
// All 10 strategies imported. Each is gated by runtime-config.strategies[key]
// at invocation time, so the user can toggle any on/off via Octave.app.
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
import { fetchAllPanes, supplement as supplementWithCloudData } from './lib/cloud_data_supplement.js';
import { checkBlackout, refreshForexFactory } from './lib/news.js';
import { evaluateChatgptPack } from './strategies/chatgpt/index.js';
import { evaluateGeminiPack } from './strategies/gemini/index.js';

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

  // News blackout — ±30m around any high-impact USD event blocks ALL setups.
  // We still evaluate strategies so /bias/dashboard reflect what would have
  // fired, but anything triggered is downgraded to invalidated with a news
  // reason so it doesn't ping Telegram.
  // (Trigger a periodic ForexFactory refresh — no-op when cache is fresh.)
  refreshForexFactory().catch(() => {});
  const blackout = checkBlackout(Date.now() / 1000, 30);

  const results = [];
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
  for (const [name, fn] of STRATEGY_TABLE) {
    if (!isStrategyEnabled(name)) continue;
    try {
      results.push(...fn(ctx));
    } catch (err) {
      log.error(`${name} evaluator threw`, { err: err.message, stack: err.stack });
    }
  }

  // ChatGPT + Gemini packs — each runs as a bundle, internally gates per-strategy
  // via isStrategyEnabled() on its own keys (CGT-* / GEM-*).
  try { results.push(...evaluateChatgptPack(ctx)); }
  catch (err) { log.error('chatgpt pack threw', { err: err.message, stack: err.stack }); }
  try { results.push(...evaluateGeminiPack(ctx)); }
  catch (err) { log.error('gemini pack threw', { err: err.message, stack: err.stack }); }

  // Attach context for the alerter. We preserve a per-strategy timeframe if set,
  // since strategies now run on their own analysis TF (15m, 1h, 4h, 1d).
  for (const r of results) {
    r.symbol = ctx.anchorSymbol;
    if (!r.timeframe) r.timeframe = ctx.anchorResolution;
    r.lastClose = ctx.lastClose;
    r.barTime = ctx.barTime;
  }

  // === 15m+ timeframe gate (per user directive 2026-05-21) ===
  // Only setups analyzed on 15m or HIGHER may be alerted. Lower-TF setups
  // (1m / 5m) are dropped silently so the user only sees higher-quality signals.
  const TF_MINUTES = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, 'D': 1440, '1D': 1440, 'W': 10080 };
  const HIGH_TF = (tf) => (TF_MINUTES[String(tf)] || 0) >= 15;
  const filtered = results.filter((r) => {
    if (!HIGH_TF(r.timeframe)) {
      log.throttled(`tf-drop-${r.strategy}`, 60_000, () =>
        log.debug('dropping sub-15m setup', { strategy: r.strategy, tf: r.timeframe, setupId: r.setupId })
      );
      return false;
    }
    return true;
  });

  // === News blackout — neutralize triggered setups, leave others intact ===
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
