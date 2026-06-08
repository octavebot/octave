/**
 * Strategy: AKIMBO (ORB · day-split Hunter + Conservative)
 *
 * Clean-room port of the PLAYBIT "Akimbo" config, which runs TWO copies of the
 * ORB engine on the same account:
 *   - Akimbo #1 = Pure Hunt (Hunter breakout) on Mon/Wed/Fri.
 *   - Akimbo #2 = Conservative retest (SD1.0) on Tue/Thu.
 * This single module reproduces both legs by switching style on the weekday.
 * 09:45–11:00 ET (Hunter) / 09:45–10:40 ET (Conservative). MNQ only.
 */

import { hunterSignal, conservativeSignal, orbPrecheck } from './_orb.js';

const HUNTER_DAYS = ['Mon', 'Wed', 'Fri'];
const CONS_DAYS   = ['Tue', 'Thu'];
const HUNT_START = 9 * 60 + 45, HUNT_END = 11 * 60;        // 09:45–11:00
const CONS_START = 9 * 60 + 45, CONS_END = 10 * 60 + 40;   // 09:45–10:40

export const meta = {
  id: 'AKIMBO',
  name: 'Akimbo · ORB Dual-Leg',
  concept: 'Opening-range engine: Hunter breakout Mon/Wed/Fri, Conservative retest Tue/Thu',
  window: 'NY open · 09:45 ET · Mon–Fri (style by day)',
  timeframes: ['5', '60'],
  instruments: ['nasdaq'],
  defaultEnabled: true,
};

export const playbook = `# Akimbo · ORB Dual-Leg

## Concept
Akimbo runs the opening-range engine with two personalities split across the week: aggressive breakout (Hunter) on Mon/Wed/Fri, and the patient retest (Conservative, SD1.0 target) on Tue/Thu. One engine, two day-dependent behaviours.

## Rules
1. **Mon/Wed/Fri** — Hunter: first 5m close beyond the 09:30–09:45 ET range, enter at close, stop opposite edge, 2R target. Window 09:45–11:00 ET.
2. **Tue/Thu** — Conservative: breakout then retest of the broken edge, enter at the edge, stop opposite edge, SD1.0 (+1 range) target. Window 09:45–10:40 ET.

## Entry / Stop / Target
- See Pure Hunt (Hunter days) and Safe Flow (Conservative days). One trade per direction per day.
`;

export function evaluate(ctx) {
  if (ctx.instrument !== 'nasdaq') return [];
  const wd = weekdayOf(ctx);
  let sigs = [];
  if (HUNTER_DAYS.includes(wd)) {
    sigs = hunterSignal(ctx, meta.id, { winStart: HUNT_START, winEnd: HUNT_END, optimize: true });
    for (const r of sigs) r.confirmations = ['Opening range 09:30–09:45', 'Hunter day (M/W/F)', 'Close beyond range'];
  } else if (CONS_DAYS.includes(wd)) {
    sigs = conservativeSignal(ctx, meta.id, { winStart: CONS_START, winEnd: CONS_END });
    for (const r of sigs) r.confirmations = ['Opening range 09:30–09:45', 'Conservative day (Tu/Th)', 'Retest of broken edge'];
  }
  return sigs;
}

export function precheck(ctx) {
  const wd = weekdayOf(ctx);
  const days = [...HUNTER_DAYS, ...CONS_DAYS];
  const hunterDay = HUNTER_DAYS.includes(wd);
  return orbPrecheck(ctx, meta.id, {
    style: 'akimbo', days,
    winStart: hunterDay ? HUNT_START : CONS_START,
    winEnd: hunterDay ? HUNT_END : CONS_END,
  });
}

function weekdayOf(ctx) {
  const d = new Date((ctx.barTime || 0) * 1000);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
}
