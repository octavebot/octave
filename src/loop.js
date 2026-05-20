import { config } from './config.js';
import { log } from './logger.js';
import { detect } from './detector.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import * as drawings from './lib/drawings.js';
import * as sessionTracker from './lib/session_tracker.js';
import { shouldLocalSuppressTelegram, cloudStatus } from './lib/cloud_heartbeat.js';

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

  // If the cloud tick is alive (recent heartbeat in the repo), cloud is the
  // source of truth for Telegram. Local stays silent on telegram but still
  // draws on TradingView so the user sees setups visually.
  const cloud = cloudStatus();
  const suppressTelegram = cloud.alive;
  if (suppressTelegram) {
    log.throttled('cloud-active', 5 * 60 * 1000, () =>
      log.info('cloud active — local suppressing telegram, drawings only', { cloudAgeMs: cloud.ageMs })
    );
  }

  for (const r of results) {
    const key = dedupKey(r);
    if (dedup.has(key)) continue;
    // Mark BEFORE sending, then roll back on failure (avoids dup spam if send is slow)
    dedup.add(key, { strategy: r.strategy, status: r.status });
    let ok = true;
    if (!suppressTelegram) {
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
      log.info('alert fired', {
        strategy: r.strategy, status: r.status, setupId: r.setupId, confidence: r.confidence,
        telegram: suppressTelegram ? 'suppressed (cloud active)' : 'sent',
      });
      // Sync TradingView drawings regardless of whether Telegram was sent.
      try {
        await drawings.syncDrawings(r);
      } catch (err) {
        log.warn('drawings sync threw', { err: err.message });
      }
    }
  }

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
