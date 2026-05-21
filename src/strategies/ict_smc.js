/**
 * Strategy 2 — ICT/SMC (formerly NY AM Killzone)
 *
 * Pipeline (per GOLD_ICT_SMC_STRATEGY.md):
 *   1. HTF narrative (Daily + 4H bias)
 *   2. Identify DOL (Draw on Liquidity)
 *   3. Killzone timing — now INFORMATIONAL only (confidence bonus)
 *   4. Judas swing — sweep against bias
 *   5. MSS / CHoCH back in line with bias
 *   6. PD array entry (FVG / OB / OTE / Breaker / Mitigation)
 *   7. Stop beyond swept structural point, TP at DOL
 *
 * Quality elevations: macro window (9:50-10:10, 10:50-11:10), SMT with DXY,
 * multi-pool sweep, fresh PD array, MSS body >1.5× ATR.
 *
 * Fires any weekday hour when all 7 requirements are met. Killzone presence
 * adds a confidence boost; absence does NOT block.
 */

import { activeSession, killzoneStatus, fmtNY, isMarketOpen } from '../lib/time.js';
import {
  buildSessionRanges,
  liquidityTargetsFor,
  lastCompletedRange,
} from '../lib/sessions.js';
import {
  detectSweep,
  detectMSS,
  findFVGs,
  orderBlockBefore,
  atr,
  oteZone,
  pdRegion,
} from '../lib/structure.js';
import { computeHtfBias, pickDOL } from '../lib/htf.js';
import { evaluateSMT } from '../lib/smt.js';
import { checkBlackout } from '../lib/news.js';

// Display label is "Strategy #2" in alerts; internal id stays 'ICT-SMC' for stable setupIds.
const NAME = 'ICT-SMC';
const LABEL = 'Strategy #2';

function findPaneByTfClass(ctx, kind) {
  const t = (k) => ctx.panesByTf.get(k);
  switch (kind) {
    case 'daily': return t('gold|1D') || t('gold|D');
    case 'h4':    return t('gold|240');
    case 'h1':    return t('gold|60');
    case 'm15':   return t('gold|15');
    case 'm5':    return t('gold|5');
    case 'm1':    return t('gold|1');
    case 'dxy_m5':return t('dxy|5') || t('dxy|15') || t('dxy|1');
  }
  return null;
}

function pickExecutionPane(ctx) {
  return findPaneByTfClass(ctx, 'm5')
    || findPaneByTfClass(ctx, 'm1')
    || findPaneByTfClass(ctx, 'm15');
}

export function evaluateICTSMC(ctx) {
  const out = [];
  const now = ctx.ts / 1000;

  // ICT/SMC uses DXY as the SMT divergence asset — that's the gold/DXY inverse
  // relationship. For nasdaq/sp the SMT logic would need a different partner
  // (ES↔NQ or ES↔YM), so we keep this strategy gold-only for now.
  if (ctx.instrument !== 'gold') return out;

  // Weekend skip — market closed. Killzone is informational only;
  // setups can fire any weekday hour as long as every requirement is met.
  if (!isMarketOpen(now)) return out;

  const kz = killzoneStatus(now);
  const kzLabel = kz.inMacro
    ? `MACRO ${kz.macroLabel}`
    : kz.inKillzone
      ? 'NY-AM yes'
      : 'outside';

  // Step 0 — news blackout
  const blackout = checkBlackout(now, 30);
  if (blackout.blocked) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-blackout-${blackout.event?.date}-${blackout.event?.time}`,
      status: 'invalidated',
      direction: 'NONE',
      setupName: `${LABEL} · BLOCKED — news ±30min`,
      summary: `Tier-1 news ${blackout.minutesAway}m away (${blackout.event?.name}). No setups taken during blackout.`,
      confidence: 0,
      details: {
        'event': blackout.event?.name || '(unknown)',
        'when': `${blackout.event?.date} ${blackout.event?.time} ET`,
        'minutes away': String(blackout.minutesAway),
      },
      invalidationLevel: null,
    }];
  }

  // Step 1 — HTF narrative
  const daily = findPaneByTfClass(ctx, 'daily');
  const h4 = findPaneByTfClass(ctx, 'h4');
  const htf = computeHtfBias(daily?.bars || [], h4?.bars || []);

  if (htf.bias === 'none' || htf.bias === 'unknown') {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-htf-${htf.bias}`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · HTF bias ${htf.bias.toUpperCase()} — standby`,
      summary: htf.reasons.join(' · '),
      confidence: 0,
      details: {
        'killzone': kzLabel,
        'HTF bias': htf.bias,
        'reasons': htf.reasons.join(' | '),
        'note': htf.bias === 'unknown'
          ? 'Add Daily and 4H gold panes to the layout to enable HTF bias.'
          : 'Strategy doc says skip when bias unclear; service waits for alignment.',
      },
      invalidationLevel: null,
    });
    return out;
  }

  // Step 2 — DOL
  const m15 = findPaneByTfClass(ctx, 'm15');
  if (!m15 || !m15.bars || m15.bars.length < 50) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-m15`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 15m gold pane`,
      summary: 'Add a 15m gold pane (GC1!/XAUUSD) to enable session-range mapping.',
      confidence: 0,
      details: { 'killzone': kzLabel, 'HTF bias': htf.bias },
      invalidationLevel: null,
    });
    return out;
  }
  const ranges = buildSessionRanges(m15.bars, now);
  const allTargets = [];
  for (const s of ['asia', 'london', 'ny_am', 'ny_pm']) {
    const r = lastCompletedRange(ranges, s);
    if (!r) continue;
    allTargets.push({ name: `${s.toUpperCase()}-Hi`, level: r.high, side: 'BSL', fromSession: s, fromDate: r.dateKey });
    allTargets.push({ name: `${s.toUpperCase()}-Lo`, level: r.low, side: 'SSL', fromSession: s, fromDate: r.dateKey });
  }
  const m15Last = m15.bars[m15.bars.length - 1].close;
  const dol = pickDOL({ bias: htf.bias, currentPrice: m15Last, candidates: allTargets });

  // Step 4 — judas swing (sweep against bias)
  const judasSide = htf.bias === 'bullish' ? 'SSL' : 'BSL';
  const judasCandidates = allTargets.filter((t) => t.side === judasSide);
  judasCandidates.sort((a, b) => Math.abs(a.level - m15Last) - Math.abs(b.level - m15Last));
  const judasTarget = judasCandidates[0] || null;
  if (!judasTarget) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-judas-target`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · ${htf.bias.toUpperCase()} bias — no judas pool available`,
      summary: 'No SSL/BSL pool from prior sessions to sweep.',
      confidence: 0.1,
      details: { 'HTF bias': htf.bias, 'killzone': kzLabel },
      invalidationLevel: null,
    });
    return out;
  }

  const execPane = pickExecutionPane(ctx);
  const execBars = execPane?.bars || m15.bars;
  const execTf = execPane?.resolution || m15.resolution;

  const a14 = atr(execBars, 14) || 0;
  const sweep = detectSweep(execBars, judasTarget.level, judasTarget.side, 12);
  const direction = htf.bias === 'bullish' ? 'LONG' : 'SHORT';

  if (!sweep) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${judasTarget.name}-pre`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · awaiting judas (${judasTarget.name})`,
      summary: `HTF ${htf.bias}. DOL: ${dol?.name || '(no clean BSL)'}. Watching for sweep of ${judasTarget.name} @ ${judasTarget.level.toFixed(2)}.`,
      confidence: 0.35,
      details: {
        'killzone': kzLabel,
        'HTF bias': htf.bias,
        'HTF conf': htf.confidence.toFixed(2),
        'DOL': dol ? `${dol.name} @ ${dol.level.toFixed(2)}` : '(none)',
        'judas target': `${judasTarget.name} @ ${judasTarget.level.toFixed(2)}`,
        'phase': 'pre-judas (step 3/7)',
      },
      invalidationLevel: null,
      geometry: {
        target: { name: judasTarget.name, level: judasTarget.level, side: judasTarget.side },
        dol: dol ? { name: dol.name, level: dol.level, side: dol.side } : null,
      },
    });
    return out;
  }

  // Excursion sanity check
  if (sweep.magnitude > 30) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${judasTarget.name}-overextended`,
      status: 'invalidated',
      direction,
      setupName: `${LABEL} · INVALIDATED — judas excursion ${sweep.magnitude.toFixed(1)} > 30`,
      summary: 'Judas ran too far. HTF bias may be wrong — skip the setup.',
      confidence: 0,
      details: {
        'killzone': kzLabel,
        'sweep wick': sweep.wickPrice.toFixed(2),
        'magnitude': sweep.magnitude.toFixed(2),
      },
      invalidationLevel: sweep.wickPrice,
    });
    return out;
  }

  // Step 5 — MSS in bias direction
  const wantedMssDir = htf.bias;
  const mss = detectMSS(execBars, wantedMssDir, { displacementMult: 1.0, lookback: 12 });

  if (!mss) {
    const dxyPane = findPaneByTfClass(ctx, 'dxy_m5');
    const smt = evaluateSMT(execBars, dxyPane?.bars || [], judasSide === 'SSL' ? 'sweep_low' : 'sweep_high', 20);
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${judasTarget.name}-swept`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · judas done, awaiting MSS`,
      summary: `${judasTarget.name} swept @ ${sweep.wickPrice.toFixed(2)}. SMT: ${smt.reason}. Waiting for ${wantedMssDir} MSS on ${execTf}m.`,
      confidence: 0.55 + (smt.confirmed ? 0.1 : 0),
      details: {
        'killzone': kzLabel,
        'HTF bias': htf.bias,
        'judas swept': `${judasTarget.name} @ ${judasTarget.level.toFixed(2)}`,
        'sweep wick': sweep.wickPrice.toFixed(2),
        'excursion': sweep.magnitude.toFixed(2),
        'SMT (DXY)': smt.reason,
        'phase': 'judas complete (step 4/7)',
        'execution TF': `${execTf}m`,
        'DOL target': dol ? `${dol.name} @ ${dol.level.toFixed(2)}` : '(unset)',
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: judasTarget.name, level: judasTarget.level, side: judasTarget.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        dol: dol ? { name: dol.name, level: dol.level, side: dol.side } : null,
      },
    });
    return out;
  }

  // Step 6 — PD array entry
  const fvgs = findFVGs(execBars, 40).filter((f) => f.side === wantedMssDir && !f.invalidated);
  const freshFvgs = fvgs.filter((f) => f.idx >= mss.idx - 1 && f.idx <= mss.idx + 1);
  const fvg = freshFvgs[freshFvgs.length - 1] || null;
  const ob = orderBlockBefore(execBars, mss.idx, wantedMssDir);

  const mssBar = execBars[mss.idx];
  const legLow = wantedMssDir === 'bullish' ? sweep.wickPrice : Math.min(mssBar.high, mssBar.low);
  const legHigh = wantedMssDir === 'bullish' ? Math.max(mssBar.high, mssBar.low) : sweep.wickPrice;
  const ote = oteZone(legLow, legHigh, wantedMssDir);

  const dxyPane = findPaneByTfClass(ctx, 'dxy_m5');
  const smt = evaluateSMT(execBars, dxyPane?.bars || [], judasSide === 'SSL' ? 'sweep_low' : 'sweep_high', 20);

  if (!fvg && !ob) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${judasTarget.name}-mss`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · MSS confirmed, awaiting entry`,
      summary: `MSS confirmed (${mss.ratio.toFixed(1)}× ATR). OTE: ${ote.shallow.toFixed(2)}-${ote.deep.toFixed(2)}. Waiting for retrace.`,
      confidence: 0.7 + (smt.confirmed ? 0.05 : 0) + (kz.inMacro ? 0.05 : 0) + (kz.inKillzone ? 0.02 : 0),
      details: {
        'killzone': kzLabel,
        'HTF bias': htf.bias,
        'judas swept': `${judasTarget.name} @ ${judasTarget.level.toFixed(2)}`,
        'sweep wick': sweep.wickPrice.toFixed(2),
        'MSS at': fmtNY(mss.time),
        'MSS x ATR': mss.ratio.toFixed(2),
        'OTE zone': `${ote.shallow.toFixed(2)} - ${ote.deep.toFixed(2)}`,
        'SMT (DXY)': smt.reason,
        'phase': 'MSS done, no entry array (step 5/7)',
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: judasTarget.name, level: judasTarget.level, side: judasTarget.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
        ote: { shallow: ote.shallow, sweet: ote.sweet, deep: ote.deep },
        dol: dol ? { name: dol.name, level: dol.level, side: dol.side } : null,
      },
    });
    return out;
  }

  // Step 7 — full setup
  let entry, entryDesc;
  if (fvg) {
    entry = fvg.mid;
    entryDesc = `FVG 50% @ ${fvg.mid.toFixed(2)} (zone ${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)})`;
  } else {
    entry = direction === 'LONG' ? ob.body.top : ob.body.bottom;
    entryDesc = `OB ${direction === 'LONG' ? 'top' : 'bottom'} @ ${entry.toFixed(2)}`;
  }

  const buffer = Math.max(0.5, 0.1 * a14);
  const stop = direction === 'LONG' ? sweep.wickPrice - buffer : sweep.wickPrice + buffer;

  const risk = Math.abs(entry - stop);
  const dolPrice = dol?.level;
  const t1 = direction === 'LONG' ? entry + risk : entry - risk;
  let t2;
  if (dolPrice && Math.abs(dolPrice - entry) > 2 * risk) {
    t2 = direction === 'LONG' ? entry + (dolPrice - entry) / 2 : entry - (entry - dolPrice) / 2;
  } else {
    t2 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  }
  const runner = dolPrice || (direction === 'LONG' ? entry + 3 * risk : entry - 3 * risk);

  const pd = pdRegion(entry, legLow, legHigh);
  const pdOk = (direction === 'LONG' && pd === 'discount') || (direction === 'SHORT' && pd === 'premium');

  // A+ scoring
  let confidence = 0.75;
  const aPlus = [];
  if (kz.inMacro) { confidence += 0.06; aPlus.push(`macro ${kz.macroLabel}`); }
  else if (kz.inKillzone) { confidence += 0.03; aPlus.push('NY-AM killzone'); }
  if (smt.confirmed) { confidence += 0.07; aPlus.push('SMT'); }
  if (mss.ratio >= 1.5) { confidence += 0.05; aPlus.push('strong MSS'); }
  if (fvg && pdOk) { confidence += 0.03; aPlus.push('FVG in PD'); }
  if (htf.confidence >= 0.8) { confidence += 0.05; aPlus.push('HTF strong'); }

  out.push({
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${judasTarget.name}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · TRIGGERED${aPlus.length >= 3 ? ' ⭐ A+' : ''}`,
    summary: `Full 7-step setup. Limit ${entry.toFixed(2)} · Stop ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} · TP2 ${t2.toFixed(2)} · Runner ${runner.toFixed(2)}`,
    confidence: Math.min(0.97, confidence),
    details: {
      'killzone': kzLabel,
      'HTF bias': `${htf.bias} (${htf.confidence.toFixed(2)})`,
      'judas swept': `${judasTarget.name} @ ${judasTarget.level.toFixed(2)}`,
      'sweep wick': sweep.wickPrice.toFixed(2),
      'MSS': `${mss.ratio.toFixed(2)}× ATR @ ${fmtNY(mss.time)}`,
      'entry': entryDesc,
      'entry price': entry.toFixed(2),
      'PD region': `${pd}${pdOk ? ' ✓' : ' ✗ (entry outside discount/premium)'}`,
      'stop': `${stop.toFixed(2)} (${risk.toFixed(2)} risk)`,
      'TP1 (50%)': `${t1.toFixed(2)} (1R)`,
      'TP2 (30%)': `${t2.toFixed(2)}`,
      'Runner': `${runner.toFixed(2)} (DOL)`,
      'SMT': smt.reason,
      'A+ confluences': aPlus.join(', ') || '(none)',
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner, risk },
    geometry: {
      target: { name: judasTarget.name, level: judasTarget.level, side: judasTarget.side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      fvg: fvg ? { top: fvg.top, bottom: fvg.bottom, time: fvg.time, side: fvg.side } : null,
      ob: !fvg && ob ? { top: ob.body.top, bottom: ob.body.bottom, time: ob.time, side: ob.side } : null,
      dol: dol ? { name: dol.name, level: dol.level, side: dol.side } : null,
      entryPlan: { direction, entry, stop, t1, t2, runner },
    },
  });

  return out;
}
