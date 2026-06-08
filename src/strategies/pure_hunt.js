/**
 * Strategy: PURE HUNT (ORB · Classic / Hunter)
 *
 * Clean-room port of the PLAYBIT "Pure Hunt" config of the N4A ORB engine.
 * The first 5m bar to close beyond the 09:30–09:45 ET opening range fires an
 * aggressive momentum entry at that close; stop at the opposite ORB edge;
 * 2R target. Trades Mon/Wed/Thu/Fri (Tuesday off), 09:45–11:00 ET. MNQ only.
 */

import { hunterSignal, orbPrecheck } from './_orb.js';

const DAYS = ['Mon', 'Wed', 'Thu', 'Fri'];   // Tue OFF (per Pure Hunt config)
const WIN_START = 9 * 60 + 45;                // 09:45 ET
const WIN_END   = 11 * 60;                    // 11:00 ET

export const meta = {
  id: 'PURE-HUNT',
  name: 'Pure Hunt · ORB Breakout',
  concept: 'Aggressive opening-range breakout (Hunter) on the first 5m close beyond the range',
  window: 'NY open · 09:45–11:00 ET · Mon/Wed/Thu/Fri',
  timeframes: ['5', '60'],
  instruments: ['nasdaq'],
  defaultEnabled: true,
};

export const playbook = `# Pure Hunt · ORB Breakout (Hunter)

## Concept
The first 15 minutes of the NY cash open (09:30–09:45 ET) sets an opening range. A decisive 5m close beyond it signals committed intent — we take the breakout in the direction of the close.

## Rules
1. **Day** — Mon, Wed, Thu, Fri (Tuesday is off).
2. **Window** — 09:45–11:00 ET.
3. **Range** — High/low of the 09:30–09:45 ET opening range (three 5m bars).
4. **Trigger** — First 5m bar to CLOSE above the range (LONG) or below it (SHORT).

## Entry
- Market at the breakout bar close.

## Stop loss
- Opposite ORB edge.

## Take profit
- TP1 ≈ 1R · runner to 2R (mode-managed). One trade per direction per day.
`;

export function evaluate(ctx) {
  if (ctx.instrument !== 'nasdaq') return [];
  const np = ctx.dateKey ? weekdayOf(ctx) : null;
  if (np && !DAYS.includes(np)) return [];
  const sigs = hunterSignal(ctx, meta.id, { winStart: WIN_START, winEnd: WIN_END, optimize: true });
  for (const r of sigs) r.confirmations = ['Opening range 09:30–09:45', 'Decisive 5m close beyond range', 'Hunter momentum entry'];
  return sigs;
}

export function precheck(ctx) {
  return orbPrecheck(ctx, meta.id, { style: 'hunter', days: DAYS, winStart: WIN_START, winEnd: WIN_END });
}

// Weekday of the anchor bar (matches evaluate()'s barTime semantics).
function weekdayOf(ctx) {
  // computeORB already derives weekday, but the day-gate must run before the
  // (more expensive) ORB build — read it straight from the anchor time.
  const d = new Date((ctx.barTime || 0) * 1000);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
}
