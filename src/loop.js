import { config } from './config.js';
import { log } from './logger.js';
import { detect } from './detector.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import * as drawings from './lib/drawings.js';
import * as sessionTracker from './lib/session_tracker.js';
import * as followUp from './lib/follow_up.js';
import { shouldLocalSuppressTelegram, cloudStatus } from './lib/cloud_heartbeat.js';
import { localTelegramBehavior, refresh as refreshConfig, get as getConfig, isMuted, muteRemainingSec } from './lib/runtime_config.js';
import { beat as heartbeat } from './lib/heartbeat.js';

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

  for (const r of results) {
    const key = dedupKey(r);
    if (dedup.has(key)) continue;

    // Telegram filter: per user directive, only TRIGGERED setups are alerted.
    // Forming / near_trigger / invalidated are still logged + drawn on the
    // chart (visible via /history), they just don't ring the phone.
    const isTelegramWorthy = r.status === 'triggered';
    const shouldSendTelegram = isTelegramWorthy && !suppressTelegram;

    // Mark BEFORE sending, then roll back on failure (avoids dup spam if send is slow)
    dedup.add(key, { strategy: r.strategy, status: r.status });
    let ok = true;
    if (shouldSendTelegram) {
      try {
        ok = await alerter.send(r, { symbol: r.symbol, timeframe: r.timeframe, lastClose: r.lastClose });
      } catch (err) {
        log.warn('alerter send threw', { err: err.message });
        ok = false;
      }
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
