import { config } from './config.js';
import { log } from './logger.js';
import { detect, getLivePrices } from './detector.js';
import * as alerter from './alerter.js';
import * as dedup from './dedup.js';
import * as sessionTracker from './lib/session_tracker.js';
import * as followUp from './lib/follow_up.js';
import * as journal from './lib/trade_journal.js';
import { appendTrade, sessionLabel } from './lib/trade_log.js';
import { refresh as refreshConfig, get as getConfig, getMode, isMuted, muteRemainingSec } from './lib/runtime_config.js';
import { drainCorruptionEvents } from './lib/safe_json.js';
import { beat as heartbeat } from './lib/heartbeat.js';
import * as paperTrader from './lib/paper_trader.js';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nyParts } from './lib/time.js';

const DETECT_SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'state', 'last-detect.json');

/**
 * Atomically persist the latest detect() results for the bot to read.
 * Skips the write when results are byte-identical to last write —
 * detector cache means most ticks return the same array, so this avoids
 * ~80% of unnecessary disk I/O during a fetch cycle.
 */
let _lastSnapshotHash = '';
function writeDetectSnapshot(results) {
  try {
    const slim = results.map((r) => ({
      strategy: r.strategy, instrument: r.instrument, direction: r.direction,
      status: r.status, confidence: r.confidence, summary: r.summary,
      setupName: r.setupName, setupId: r.setupId, geometry: r.geometry,
      entryPlan: r.entryPlan,
    }));
    const body = JSON.stringify(slim);
    // Always refresh the `at` timestamp on disk so consumers (bot.js's
    // runDetectChild has a 120s staleness gate) know the snapshot is current
    // even when the slim payload is byte-identical to the prior tick. Without
    // this, a quiet market with no signal-state changes would let the snapshot
    // go "stale" while still being CORRECT, triggering a wasteful detect child
    // spawn every 2 minutes.
    if (body === _lastSnapshotHash) {
      try {
        const at = Date.now();
        writeFileSync(DETECT_SNAPSHOT + '.tmp', JSON.stringify({ at, results: slim }));
        renameSync(DETECT_SNAPSHOT + '.tmp', DETECT_SNAPSHOT);
      } catch {}
      return;
    }
    _lastSnapshotHash = body;
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

  // Mute state — checked once per tick before any early bail. The follow-up
  // tracker MUST run every tick (open trades have to be monitored against the
  // live feed even on bars where no strategy produced a result), so it lives
  // AFTER this block and outside the results-guard below.
  refreshConfig();
  const suppressTelegram = isMuted();
  if (suppressTelegram) {
    log.throttled('tg-suppressed', 5 * 60 * 1000, () =>
      log.info('telegram suppressed (muted)', { muteSecRemaining: muteRemainingSec() })
    );
  }

  // Alert generation only runs when strategies produced results this tick.
  if (results && results.length > 0) {
  // Sort: highest-priority status first, then highest confidence
  const PRI = { triggered: 0, invalidated: 1, near_trigger: 2, forming: 3 };
  results.sort((a, b) => {
    const pa = PRI[a.status] ?? 9;
    const pb = PRI[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  // ── Confidence gate ──
  // Gate triggered setups on the strategy's BASE confidence (win-rate-derived
  // qualityConfidence), which is DATA-VALIDATED: a 1-year backtest shows base
  // conf <0.55 is net NEGATIVE (−6R) while ≥0.55 is +690R. The threshold lives
  // in runtime-config (aiEngine.threshold, default 0.55) — kept under that key
  // for config back-compat; it's a pure confidence gate, no AI/LLM involved.
  // Per-mode gate (risk_manager MODES) is authoritative: aggressive 0.50 (≈off,
  // required by the ≥2.5RR low-win-rate regime), passive 0.65 (quality filter
  // for its higher-win-rate profile). Falls back to aiEngine.threshold only if a
  // mode somehow lacks a gate.
  const confThreshold = getMode().gate ?? getConfig().aiEngine?.threshold ?? 0.55;

  // Conflict guard — never issue a signal opposite to a position already open
  // on the same instrument (user: "bot said sell AND buy the same instrument,
  // different strategies"). First position wins: the opposite signal is skipped
  // (no Telegram, no paper trade) and logged. Build the open-direction map from
  // the follow-up tracker once up front; we also fold in positions sent earlier
  // in THIS loop so two opposite signals on the same tick can't both go out.
  const openDirByInst = new Map(); // instrument -> Set<'LONG'|'SHORT'>
  try {
    for (const s of (followUp.active() || [])) {
      if (!s?.instrument || !s?.direction) continue;
      if (!openDirByInst.has(s.instrument)) openDirByInst.set(s.instrument, new Set());
      openDirByInst.get(s.instrument).add(s.direction);
    }
  } catch (err) { log.warn('conflict-guard: follow_up.active() threw', { err: err.message }); }
  const oppositeOf = (d) => (d === 'LONG' ? 'SHORT' : d === 'SHORT' ? 'LONG' : null);

  for (const r of results) {
    const key = dedupKey(r);
    if (dedup.has(key)) continue;

    // Telegram filter: per user directive, only TRIGGERED setups are alerted.
    // Forming / near_trigger / invalidated are still logged + drawn on the
    // chart (visible via /history), they just don't ring the phone.
    const isTelegramWorthy = r.status === 'triggered';

    // Opposite-direction position already open on this instrument? Skip.
    const opp = oppositeOf(r.direction);
    const conflict = isTelegramWorthy && !!opp && openDirByInst.get(r.instrument)?.has(opp);

    const baseConf = r.confidence ?? 0;
    const confGated = isTelegramWorthy && baseConf < confThreshold;
    const shouldSendTelegram = isTelegramWorthy && !suppressTelegram && !confGated && !conflict;

    // Mark BEFORE sending, then roll back on failure (avoids dup spam if send is slow)
    dedup.add(key, { strategy: r.strategy, status: r.status });
    let ok = true;
    if (shouldSendTelegram) {
      // Paper trader runs BEFORE alerter.send so its per-account decisions
      // can be displayed on the signal card. Decisions array is empty if
      // no account is enabled, in which case the card looks identical.
      // Fully wrapped — never throws.
      try { r.paperDecisions = paperTrader.onTriggered(r); }
      catch (err) {
        log.warn('paper_trader.onTriggered threw', { setupId: r.setupId, err: err.message });
        r.paperDecisions = [];
      }
      try {
        ok = await alerter.send(r, { symbol: r.symbol, timeframe: r.timeframe, lastClose: r.lastClose });
      } catch (err) {
        log.warn('alerter send threw', { err: err.message });
        ok = false;
      }
    } else if (conflict) {
      log.info('alert conflict-skipped', {
        strategy: r.strategy, setupId: r.setupId, direction: r.direction,
        reason: `opposite ${opp} already open on ${r.instrument}`,
      });
    } else if (confGated) {
      log.info('alert conf-gated', {
        strategy: r.strategy, setupId: r.setupId,
        confidence: baseConf, threshold: confThreshold,
      });
    }
    if (!ok) {
      dedup.remove(key);
      log.warn('telegram send failed — dedup rolled back', { key });
    } else {
      // A signal we actually sent now occupies the instrument in its direction
      // — fold it into the map so a later same-tick opposite signal is skipped.
      if (shouldSendTelegram && r.direction) {
        if (!openDirByInst.has(r.instrument)) openDirByInst.set(r.instrument, new Set());
        openDirByInst.get(r.instrument).add(r.direction);
      }
      const tgState = !isTelegramWorthy
        ? 'skipped (not triggered)'
        : conflict ? `skipped (conflicts open ${opp})`
        : confGated ? 'gated (low confidence)'
        : suppressTelegram ? 'suppressed (muted)'
        : 'sent';
      log.info('alert fired', {
        strategy: r.strategy, status: r.status, setupId: r.setupId, confidence: r.confidence,
        telegram: tgState,
      });
      // NOTE: the auto-journal 'in' is NOT written here. A triggered signal is
      // a limit order — it may never fill. The entry is journalled only when
      // the follow-up tracker reports a 'filled' milestone (see below), so
      // invalidated / missed / unfilled setups never become phantom trades.
      // Paper trader runs ABOVE (pre-alerter.send) so its decisions can be
      // shown on the card. No second hook here.
    }
  }
  } // end alert-generation guard (results present)

  // === Follow-up tracker — fire milestone Telegrams (BE/TP1/TP2/SL/expiry) ===
  // Price the tracker DIRECTLY off the live feed (detector.getLivePrices), not
  // off this tick's strategy results. Two reasons: (1) an open trade must be
  // checked every tick regardless of whether a strategy emitted a result for
  // its instrument this bar — otherwise TP/SL go unmonitored on quiet bars;
  // (2) getLivePrices carries the bar HIGH/LOW so an intrabar wick to a target
  // is detected, not just a close-through. Falls back to result lastClose if
  // the live-price snapshot is somehow empty.
  let priceMap = getLivePrices() || {};
  if (Object.keys(priceMap).length === 0) {
    priceMap = {};
    for (const r of results) {
      if (r.instrument && r.lastClose != null && priceMap[r.instrument] == null) {
        priceMap[r.instrument] = r.lastClose;
      }
    }
  }
  // Numeric current price per instrument, for follow-up Telegram + exit price.
  const lastPrice = (inst) => {
    const q = priceMap[inst];
    return q == null ? null : (typeof q === 'number' ? q : q.last);
  };
  if (Object.keys(priceMap).length > 0) {
    let milestones = [];
    try { milestones = followUp.step(priceMap); }
    catch (err) { log.warn('follow-up step threw', { err: err.message }); }
    for (const m of milestones) {
      const inst = m.setup.instrument || 'gold';
      log.info('follow-up milestone', { setupId: m.setup.setupId, milestone: m.milestone, strategy: m.setup.strategy, instrument: inst });
      if (!suppressTelegram) {
        try { await alerter.sendFollowUp({ setup: m.setup, milestone: m.milestone, currentPrice: lastPrice(inst) }); }
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
        } else if (m.milestone === 'tp1') {
          // TP1 is a PARTIAL scale-out, not a close — the runner stays live to
          // TP2/SL. Record a breadcrumb only; the SINGLE terminal trade-log row
          // (with net R) is written when the runner finally closes. Previously
          // this wrote a WIN row at TP1 AND another at TP2 for the same setup,
          // double-counting it in the live trade log + win-rate maths.
          journal.log({ action: 'note', setupId: s.setupId, text: `TP1 partial @ ${s.t1} — scaled 50%, runner to TP2`, auto: true });
        } else if (['tp2', 'sl', 'runner', 'expired'].includes(m.milestone)) {
          const exitPrice = lastPrice(inst);
          const reason = m.milestone === 'runner' ? 'tp2' : m.milestone;
          journal.log({ action: 'out', setupId: s.setupId, reason, price: exitPrice, auto: true });
          const long = s.direction === 'LONG';
          const entry = s.entry;
          const risk = Math.abs(entry - s.stop);
          const ptsFrom = (px) => px == null ? 0 : (long ? px - entry : entry - px);
          const tp1Banked = !!s.milestonesFired?.tp1;
          // Closing-leg points, BE-aware: an SL after +1R/TP1 exits at breakeven.
          let legPts;
          if (m.milestone === 'tp2' || m.milestone === 'runner') legPts = ptsFrom(s.t2 ?? s.t1);
          else if (m.milestone === 'sl') legPts = ptsFrom(s.wasBeStop ? entry : s.stop);
          else legPts = ptsFrom(exitPrice);   // expired
          // Net = TP1 half (if scaled) + the closing leg on the remaining half.
          const netPoints = tp1Banked ? 0.5 * ptsFrom(s.t1) + 0.5 * legPts : legPts;
          const outcome = netPoints > 0 ? 'WIN'
                        : netPoints < 0 ? 'LOSS'
                        : m.milestone === 'expired' ? 'EXPIRED' : 'BE';
          appendTrade({
            setupId: s.setupId, strategy: s.strategy, instrument: inst,
            direction: s.direction, entry, sl: s.stop, tp: s.t2 ?? s.t1 ?? null,
            exit: exitPrice,
            risk_reward: risk ? netPoints / risk : null,
            result_points: netPoints,
            duration_minutes: s.filledAt ? Math.round((Date.now() - s.filledAt) / 60000) : null,
            session: sessionLabel(Date.now() / 1000),
            outcome,
            exit_reason: m.milestone,   // tp2 | runner | sl | expired
          }, 'live');
        }
      } catch (err) {
        log.warn('auto-journal milestone threw', { setupId: m.setup.setupId, milestone: m.milestone, err: err.message });
      }

      // Paper trader close — fully wrapped, never throws into the loop.
      try {
        const inst = m.setup.instrument || 'gold';
        paperTrader.onMilestone(m.setup, m.milestone, lastPrice(inst));
      } catch (err) {
        log.warn('paper_trader.onMilestone threw', { setupId: m.setup.setupId, milestone: m.milestone, err: err.message });
      }
    }
  }

  // End-of-day report — fire once when the clock first enters the 17:00 NY hour.
  try { await maybeDailyReport(suppressTelegram); }
  catch (err) { log.warn('daily report threw', { err: err.message }); }

  // Surface state-file corruption (recovered or reset) — never silent now.
  try {
    for (const ev of drainCorruptionEvents()) {
      const base = String(ev.file || '').split('/').pop();
      const what = ev.action === 'recovered-from-bak'
        ? 'was corrupt — auto-recovered from backup'
        : 'was corrupt and had NO usable backup — reset to default';
      await alerter.sendOpsAlert(`🟠 *State file corruption*\n\`${base}\` ${what}.\nEngine kept running; verify /account and /setups if numbers look off.`);
    }
  } catch (err) { log.warn('corruption drain threw', { err: err.message }); }

  // Silent-state dead-man's switch — catches "alive but can't/won't fire".
  try { await maybeHealthCheck(); }
  catch (err) { log.warn('health check threw', { err: err.message }); }

  // End-of-tick heartbeat with a count of results so dashboards see activity
  heartbeat('signal-engine', { phase: 'tick-end', last_result_count: results?.length || 0 });
  await sleep(config.pollIntervalMs);
}

// ─── Silent-state dead-man's switch ───────────────────────────────────────
// Catches states where the bot is fully alive (fresh heartbeat) yet structurally
// CANNOT deliver signals — the kind of failure the watchdog can't see. Runs at
// most every 15 min; each condition is deduped on its own timer. In-memory only
// (a restart legitimately re-checks: if strategies are still all-off, re-warn).
let _lastHealthCheck = 0;
const _health = { allDisabledAt: 0, mutedReminderAt: 0 };

async function maybeHealthCheck() {
  const now = Date.now();
  if (now - _lastHealthCheck < 15 * 60 * 1000) return;
  _lastHealthCheck = now;

  const cfg = getConfig() || {};
  const stratIds = Object.keys(cfg.strategies || {});
  const enabled = stratIds.filter((id) => cfg.strategies[id]).length;

  // All strategies OFF → the engine can never fire. Only meaningful once the
  // registry has populated the config (stratIds non-empty) to avoid a
  // first-boot false alarm.
  if (stratIds.length > 0 && enabled === 0) {
    if (now - _health.allDisabledAt > 6 * 3600 * 1000) {
      _health.allDisabledAt = now;
      await alerter.sendOpsAlert('⚠️ *All strategies are OFF* — Octave will not fire any signals.\nSend `/strategies`, then `/enable <n>` to resume.');
    }
  } else {
    _health.allDisabledAt = 0;
  }

  // Muted-and-maybe-forgot reminder: only when a long mute remains.
  const muteLeftSec = muteRemainingSec();
  if (muteLeftSec > 12 * 3600) {
    if (now - _health.mutedReminderAt > 12 * 3600 * 1000) {
      _health.mutedReminderAt = now;
      await alerter.sendOpsAlert(`🔕 *Alerts still muted* (~${Math.round(muteLeftSec / 3600)}h left). \`/unmute\` to resume signals.`);
    }
  } else {
    _health.mutedReminderAt = 0;
  }
}

// ─── End-of-day report ──────────────────────────────────────────────────
// At 17:00 NY (gold-futures close) send a summary of the day. The last-sent
// date is persisted so a restart inside the 17:00 hour doesn't re-send.
const DAILY_REPORT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'state', 'daily-report.json');
let lastReportDate = (() => {
  try { return JSON.parse(readFileSync(DAILY_REPORT_FILE, 'utf8')).lastSentDate || ''; }
  catch { return ''; }
})();

async function maybeDailyReport(suppressTelegram) {
  const np = nyParts(Date.now() / 1000);
  if (np.h !== 17) return;                 // only during the 17:00-17:59 NY hour
  if (lastReportDate === np.dateKey) return; // already sent today
  lastReportDate = np.dateKey;
  try { writeFileSync(DAILY_REPORT_FILE, JSON.stringify({ lastSentDate: np.dateKey })); } catch {}

  const { buildDailyReport } = await import('./lib/daily_report.js');
  const { text } = buildDailyReport();
  log.info('daily report', { date: np.dateKey });
  if (!suppressTelegram) {
    try { await alerter.sendDailyReport(text); }
    catch (err) { log.warn('daily report send threw', { err: err.message }); }
  }
}

export async function run() {
  log.info('loop started', {
    pollMs: config.pollIntervalMs,
    reconnectMs: config.reconnectIntervalMs,
    lockSymbol: config.lockSymbol || '(follow active)',
  });
  // Drop closed setups >7d old + stale-open setups >36h old on startup.
  // prune() existed in follow_up.js but was never called anywhere — closed
  // entries accumulated forever in follow-ups.json.
  try { followUp.prune(); } catch (err) { log.warn('follow-up prune threw', { err: err.message }); }
  while (!stopping) await tick();
  log.info('loop stopped');
}
