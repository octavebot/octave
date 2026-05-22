import { config } from './config.js';
import { log } from './logger.js';
import { detect } from './detector.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import * as drawings from './lib/drawings.js';
import * as sessionTracker from './lib/session_tracker.js';
import * as followUp from './lib/follow_up.js';
import * as journal from './lib/trade_journal.js';
import { appendTrade, sessionLabel } from './lib/trade_log.js';
import { shouldLocalSuppressTelegram, cloudStatus } from './lib/cloud_heartbeat.js';
import { localTelegramBehavior, refresh as refreshConfig, get as getConfig, isMuted, muteRemainingSec } from './lib/runtime_config.js';
import { beat as heartbeat } from './lib/heartbeat.js';
import * as holyAi from './lib/holy_ai.js';
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DETECT_SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'state', 'last-detect.json');

/** Atomically persist the latest detect() results for the bot to read. */
function writeDetectSnapshot(results) {
  try {
    const slim = results.map((r) => ({
      strategy: r.strategy, instrument: r.instrument, direction: r.direction,
      status: r.status, confidence: r.confidence, summary: r.summary,
      setupName: r.setupName, setupId: r.setupId, geometry: r.geometry,
      entryPlan: r.entryPlan,
    }));
    writeFileSync(DETECT_SNAPSHOT + '.tmp', JSON.stringify({ at: Date.now(), results: slim }));
    renameSync(DETECT_SNAPSHOT + '.tmp', DETECT_SNAPSHOT);
  } catch { /* snapshot is best-effort — never break the loop */ }
}

let stopping = false;
export function stop() { stopping = true; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function dedupKey(result) {
  // setupId is already unique per (strategy, session, date, target, phase).
  // Dropping barTime: each lifecycle transition fires once per setup, not
  // once per 15m bar. The 6h dedup TTL still cleans up stale entries.
  return `${result.setupId}:${result.status}`;
}

async function tick() {
  // Heartbeat FIRST so even if everything else throws, we're recorded as alive
  heartbeat('signal-engine', { phase: 'tick-start' });

  // Session boundary check (cheap, runs every tick)
  try {
    await sessionTracker.checkSessionChange();
  } catch (err) {
    log.warn('session tracker threw', { err: err.message });
  }

  let results;
  try {
    results = await detect();
  } catch (err) {
    log.throttled('detect-fail', config.reconnectIntervalMs, () =>
      log.warn('detect failed', { err: err.message })
    );
    await sleep(config.reconnectIntervalMs);
    return;
  }

  // Persist this tick's detect snapshot so the bot's /bias and /setups can
  // read it instantly instead of spawning a slow detect child (which gets
  // SIGKILLed when the VPS is busy → "detect crashed (exit null)").
  writeDetectSnapshot(results || []);

  if (!results || results.length === 0) {
    log.debug('tick (no results)');
    await sleep(config.pollIntervalMs);
    return;
  }

  // Sort: highest-priority status first, then highest confidence
  const PRI = { triggered: 0, invalidated: 1, near_trigger: 2, forming: 3 };
  results.sort((a, b) => {
    const pa = PRI[a.status] ?? 9;
    const pb = PRI[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  // Refresh config so mode/strategy/mute toggles take effect immediately
  refreshConfig();
  const cfg = getConfig();
  // Mute first — if user told the bot /mute, no telegram at all
  const muted = isMuted();
  // Compute effective Telegram behavior:
  //   mode=auto  → cloud-active suppresses; cloud-stale sends (current behavior)
  //   mode=cloud → always suppress (cloud is forced primary)
  //   mode=local → always send (cloud is forced silent)
  const cloud = cloudStatus();
  const behavior = localTelegramBehavior({ cloudAlive: cloud.alive });
  const suppressTelegram = muted || behavior === 'suppress';
  if (suppressTelegram) {
    log.throttled('tg-suppressed', 5 * 60 * 1000, () =>
      log.info('telegram suppressed', { mode: cfg.mode, muted, muteSecRemaining: muteRemainingSec(), cloudAlive: cloud.alive, cloudAgeMs: cloud.ageMs })
    );
  }

  // ── HOLY AI ENGINE — score triggered setups before sending ──
  // Runs once per tick (regime is cached 30min, scores cached per setupId).
  // If engine is disabled OR LLM is offline, scoreSetup returns a no-op that
  // preserves the original confidence — trading flow is never blocked.
  const aiCfg = holyAi.getEngineConfig();
  let regimeCtx = null;
  if (aiCfg.enabled) {
    try { regimeCtx = await holyAi.marketRegime(); } catch (err) { log.warn('holy_ai regime threw', { err: err.message }); }
  }

  for (const r of results) {
    const key = dedupKey(r);
    if (dedup.has(key)) continue;

    // Telegram filter: per user directive, only TRIGGERED setups are alerted.
    // Forming / near_trigger / invalidated are still logged + drawn on the
    // chart (visible via /history), they just don't ring the phone.
    const isTelegramWorthy = r.status === 'triggered';

    // AI scoring gate — only run on triggered setups (rest don't fire Telegram anyway).
    // The AI score multiplies into r.confidence. Setups below aiCfg.threshold
    // are dropped from Telegram but still logged (so backtesting + audit shows
    // what AI filtered out).
    let aiScore = null;
    if (isTelegramWorthy && aiCfg.enabled) {
      try {
        aiScore = await holyAi.scoreSetup(r, { regime: regimeCtx });
        r.aiScore = aiScore;
        r.adjustedConfidence = aiScore.adjusted_confidence;
      } catch (err) {
        log.warn('holy_ai scoreSetup threw', { setupId: r.setupId, err: err.message });
      }
    }
    const aiGated = isTelegramWorthy && aiScore?.aiEnabled && aiScore.adjusted_confidence < aiCfg.threshold;
    const shouldSendTelegram = isTelegramWorthy && !suppressTelegram && !aiGated;

    // Mark BEFORE sending, then roll back on failure (avoids dup spam if send is slow)
    dedup.add(key, { strategy: r.strategy, status: r.status });
    let ok = true;
    if (shouldSendTelegram) {
      // Generate commentary (best-effort; '' if AI offline or fails)
      if (aiCfg.enabled) {
        try {
          const cmt = await holyAi.commentary(r, { regime: regimeCtx });
          if (cmt?.text) r.aiCommentary = cmt.text;
        } catch (err) { log.warn('holy_ai commentary threw', { setupId: r.setupId, err: err.message }); }
      }
      try {
        ok = await alerter.send(r, { symbol: r.symbol, timeframe: r.timeframe, lastClose: r.lastClose });
      } catch (err) {
        log.warn('alerter send threw', { err: err.message });
        ok = false;
      }
    } else if (aiGated) {
      log.info('alert ai-gated', {
        strategy: r.strategy, setupId: r.setupId,
        originalConfidence: r.confidence, aiScore: aiScore.score,
        adjustedConfidence: aiScore.adjusted_confidence, threshold: aiCfg.threshold,
        reasoning: aiScore.reasoning,
      });
    }
    if (!ok) {
      dedup.remove(key);
      log.warn('telegram send failed — dedup rolled back', { key });
    } else {
      const tgState = !isTelegramWorthy
        ? 'skipped (not triggered)'
        : suppressTelegram ? 'suppressed (cloud active / muted)' : 'sent';
      log.info('alert fired', {
        strategy: r.strategy, status: r.status, setupId: r.setupId, confidence: r.confidence,
        telegram: tgState,
      });
      // NOTE: the auto-journal 'in' is NOT written here. A triggered signal is
      // a limit order — it may never fill. The entry is journalled only when
      // the follow-up tracker reports a 'filled' milestone (see below), so
      // invalidated / missed / unfilled setups never become phantom trades.

      // Sync TradingView drawings regardless of whether Telegram was sent —
      // user still sees the setup forming on the chart in real time.
      try {
        await drawings.syncDrawings(r);
      } catch (err) {
        log.warn('drawings sync threw', { err: err.message });
      }
    }
  }

  // === Follow-up tracker — fire milestone Telegrams (BE/TP1/TP2/SL/expiry) ===
  // Build a per-instrument price map from the freshest result for each.
  // Each setup is matched against the price for ITS instrument so a gold
  // setup never gets stopped by a nasdaq tick.
  const priceMap = {};
  for (const r of results) {
    if (r.instrument && r.lastClose != null && priceMap[r.instrument] == null) {
      priceMap[r.instrument] = r.lastClose;
    }
  }
  if (Object.keys(priceMap).length > 0) {
    let milestones = [];
    try { milestones = followUp.step(priceMap); }
    catch (err) { log.warn('follow-up step threw', { err: err.message }); }
    for (const m of milestones) {
      const inst = m.setup.instrument || 'gold';
      log.info('follow-up milestone', { setupId: m.setup.setupId, milestone: m.milestone, strategy: m.setup.strategy, instrument: inst });
      if (!suppressTelegram) {
        try { await alerter.sendFollowUp({ setup: m.setup, milestone: m.milestone, currentPrice: priceMap[inst] }); }
        catch (err) { log.warn('follow-up send threw', { err: err.message }); }
      }
      // Record milestone events. The limit lifecycle has three outcome classes:
      //   filled            → the entry actually happened: journal the 'in'
      //   invalidated/      → the limit never filled: record as CANCELLED so it
      //   missed/unfilled     shows in the log but is NEVER a win or a loss
      //   tp1/tp2/sl/...    → the trade closed: journal 'out' + WIN/LOSS row
      try {
        const s = m.setup;
        if (m.milestone === 'filled') {
          journal.log({
            action: 'in', setupId: s.setupId, instrument: inst, strategy: s.strategy,
            direction: s.direction, contracts: 0, price: s.entry, stop: s.stop,
            t1: s.t1, t2: s.t2, auto: true,
          });
        } else if (['invalidated', 'missed', 'unfilled'].includes(m.milestone)) {
          // No trade occurred. One CANCELLED row — distinct from WIN/LOSS,
          // excluded from win-rate maths.
          appendTrade({
            setupId: s.setupId, strategy: s.strategy, instrument: inst,
            direction: s.direction, entry: s.entry, sl: s.stop,
            tp: s.t2 ?? s.t1 ?? null, exit: null,
            risk_reward: null, result_points: 0,
            duration_minutes: s.placedAt ? Math.round((Date.now() - s.placedAt) / 60000) : null,
            session: sessionLabel(Date.now() / 1000),
            outcome: 'CANCELLED', exit_reason: m.milestone,
          }, 'live');
        } else if (m.milestone === 'be') {
          journal.log({ action: 'be', setupId: s.setupId, auto: true });
        } else if (['tp1', 'tp2', 'sl', 'runner', 'expired'].includes(m.milestone)) {
          const exitPrice = priceMap[inst];
          const reason = m.milestone === 'runner' ? 'tp2' : m.milestone;
          journal.log({ action: 'out', setupId: s.setupId, reason, price: exitPrice, auto: true });
          const isWin = ['tp1', 'tp2', 'runner'].includes(m.milestone);
          const isLoss = m.milestone === 'sl';
          const entry = s.entry, stop = s.stop;
          const risk = Math.abs(entry - stop);
          const resultPoints = isWin && exitPrice != null ? Math.abs(exitPrice - entry)
                              : isLoss ? -risk : 0;
          appendTrade({
            setupId: s.setupId, strategy: s.strategy, instrument: inst,
            direction: s.direction, entry, sl: stop, tp: s.t2 ?? s.t1 ?? null,
            exit: exitPrice,
            risk_reward: risk ? resultPoints / risk : null,
            result_points: resultPoints,
            duration_minutes: s.filledAt ? Math.round((Date.now() - s.filledAt) / 60000) : null,
            session: sessionLabel(Date.now() / 1000),
            outcome: isWin ? 'WIN' : isLoss ? 'LOSS' : m.milestone === 'expired' ? 'EXPIRED' : 'OTHER',
          }, 'live');
        }
      } catch (err) {
        log.warn('auto-journal milestone threw', { setupId: m.setup.setupId, milestone: m.milestone, err: err.message });
      }
    }
  }

  // End-of-tick heartbeat with a count of results so dashboards see activity
  heartbeat('signal-engine', { phase: 'tick-end', last_result_count: results?.length || 0 });
  await sleep(config.pollIntervalMs);
}

export async function run() {
  log.info('loop started', {
    pollMs: config.pollIntervalMs,
    reconnectMs: config.reconnectIntervalMs,
    lockSymbol: config.lockSymbol || '(follow active)',
  });
  while (!stopping) await tick();
  log.info('loop stopped');
}
