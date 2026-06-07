/**
 * Strategy: SAFE FLOW (ORB · Classic / Conservative)
 *
 * Clean-room port of the PLAYBIT "Safe Flow" config of the N4A ORB engine.
 * After a 5m close breaks the 09:30–09:45 ET opening range, we wait for price
 * to RETEST the broken edge and enter there (limit), stop at the opposite edge,
 * targeting the SD1.0 measured move (+1 ORB range). Trades Mon/Tue/Thu/Fri,
 * 09:45–10:40 ET. Plus the Revised/FVG leg (Mon/Wed, 09:45–13:00) — the "Both"
 * config's second engine. MNQ only.
 */

import { conservativeSignal, fvgSignal, orbPrecheck } from './_orb.js';

// Classic-Conservative leg: Mon/Tue/Thu/Fri, 09:45–10:40 ET.
const DAYS = ['Mon', 'Tue', 'Thu', 'Fri'];
const WIN_START = 9 * 60 + 45;                // 09:45 ET
const WIN_END   = 10 * 60 + 40;               // 10:40 ET
// Revised/FVG leg: Mon/Wed, 09:45–13:00 ET (the "Both" config's second engine).
const FVG_DAYS = ['Mon', 'Wed'];
const FVG_START = 9 * 60 + 45;                // 09:45 ET
const FVG_END   = 13 * 60;                    // 13:00 ET

export const meta = {
  id: 'SAFE-FLOW',
  name: 'Safe Flow · ORB Retest',
  concept: 'Conservative ORB retest (SD1.0) + post-breakout FVG retrace (Revised)',
  window: 'Conservative 09:45–10:40 (M/Tu/Th/F) · FVG 09:45–13:00 (M/W)',
  timeframes: ['5'],
  instruments: ['nasdaq'],
  defaultEnabled: true,
};

export const playbook = `# Safe Flow · ORB Retest (Conservative)

## Concept
A breakout that holds tends to retest the broken edge before extending. Entering on the retest gives a tighter, higher-probability fill than chasing the breakout. Target is the SD1.0 measured move (one opening-range height beyond the edge).

## Rules
1. **Day** — Mon, Tue, Thu, Fri (Wednesday is off).
2. **Window** — 09:45–10:40 ET.
3. **Range** — High/low of the 09:30–09:45 ET opening range (three 5m bars).
4. **Trigger** — A 5m bar closed beyond the range, then price returns to the
   broken edge (retest).

## Entry
- Limit at the broken ORB edge.

## Stop loss
- Opposite ORB edge.

## Take profit
- SD1.0 = +1 ORB range (100% exit in the original; Octave scales out per the active mode).

## Revised / FVG leg (Mon/Wed · 09:45–13:00 ET)
- A post-breakout 3-candle FVG sitting at/above the ORB high (or at/below the low), strict min 2.0 pt.
- Enter on the retrace into the gap edge (≤15 bars after it forms); stop the far gap edge ∓1.0; target 2R.
`;

export function evaluate(ctx) {
  if (ctx.instrument !== 'nasdaq') return [];
  const wd = weekdayOf(ctx);
  const out = [];
  if (DAYS.includes(wd)) {
    const cons = conservativeSignal(ctx, meta.id, { winStart: WIN_START, winEnd: WIN_END });
    for (const r of cons) r.confirmations = ['Opening range 09:30–09:45', 'Breakout close confirmed', 'Retest of broken edge'];
    out.push(...cons);
  }
  if (FVG_DAYS.includes(wd)) {
    const fvg = fvgSignal(ctx, meta.id, { winStart: FVG_START, winEnd: FVG_END });
    for (const r of fvg) r.confirmations = ['Opening range 09:30–09:45', 'Post-breakout FVG above/below ORB', 'Retrace into gap'];
    out.push(...fvg);
  }
  return out;
}

export function precheck(ctx) {
  // Show whichever leg is live today: FVG on Mon/Wed (wider window), else Conservative.
  const wd = weekdayOfNow(ctx);
  if (FVG_DAYS.includes(wd) && !DAYS.includes(wd)) {
    return orbPrecheck(ctx, meta.id, { style: 'fvg', days: FVG_DAYS, winStart: FVG_START, winEnd: FVG_END });
  }
  return orbPrecheck(ctx, meta.id, { style: 'conservative', days: DAYS, winStart: WIN_START, winEnd: WIN_END });
}

function weekdayOfNow(ctx) {
  const d = new Date(ctx.ts || Date.now());
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
}

function weekdayOf(ctx) {
  const d = new Date((ctx.barTime || 0) * 1000);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
}
