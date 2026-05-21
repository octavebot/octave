#!/usr/bin/env node
/**
 * Crash-isolated detector runner. Same philosophy as run-backtest-child.js:
 * if a strategy evaluator throws/OOMs, the parent bot stays alive.
 *
 * Outputs ONE line on stdout: RESULT:<json> with the full results array.
 */

import { detect } from '../src/detector.js';

async function main() {
  const t0 = Date.now();
  const results = await detect();
  // Slim each result to JSON-safe fields (drop functions / circular refs)
  const slim = (results || []).map((r) => ({
    strategy: r.strategy,
    setupId: r.setupId,
    status: r.status,
    direction: r.direction,
    setupName: r.setupName,
    summary: r.summary,
    confidence: r.confidence,
    details: r.details || {},
    entryPlan: r.entryPlan || null,
    invalidationLevel: r.invalidationLevel ?? null,
    geometry: r.geometry ? {
      target: r.geometry.target || null,
      sweep:  r.geometry.sweep  || null,
      mss:    r.geometry.mss    || null,
      fvg:    r.geometry.fvg    || null,
    } : null,
  }));
  console.log(`RESULT:${JSON.stringify({ ok: true, durationMs: Date.now() - t0, count: slim.length, results: slim })}`);
}

process.on('uncaughtException', (err) => {
  console.error('CHILD_UNCAUGHT:', err.message);
  console.log(`RESULT:${JSON.stringify({ error: 'uncaught: ' + err.message })}`);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  console.error('CHILD_REJECTED:', err?.message);
  console.log(`RESULT:${JSON.stringify({ error: 'unhandled: ' + (err?.message || err) })}`);
  process.exit(3);
});

main().catch((e) => {
  console.error('CHILD_MAIN:', e.message);
  console.log(`RESULT:${JSON.stringify({ error: e.message })}`);
  process.exit(4);
});
