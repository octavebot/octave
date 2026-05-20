/**
 * Per-setup TradingView drawing manager.
 *
 * For each detector result, builds a set of canonical shapes (target line,
 * sweep marker, MSS line, entry zone, stop, TPs) and syncs them on the chart:
 *
 *   syncDrawings(result):
 *     - if result.status === 'invalidated' → remove ALL shapes for this setupId
 *     - else                              → remove old shapes for this setupId,
 *                                            then add fresh ones for the current phase
 *
 * Persists `{setupId: [entityId, ...]}` to src/state/drawings.json so a service
 * restart doesn't orphan shapes on the chart.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';

// Lazy-load tradingview-mcp so this module imports cleanly on the VPS where
// the package isn't installed. Drawings are a no-op on VPS (no TradingView
// Desktop to draw on). Alerts still fire via Telegram + dashboard.
let _drawing = null;
let _loadAttempted = false;
async function getDrawing() {
  if (_loadAttempted) return _drawing;
  _loadAttempted = true;
  try {
    const m = await import('tradingview-mcp/core');
    _drawing = m.drawing;
  } catch {
    _drawing = null;
  }
  return _drawing;
}
const drawing = {
  async drawShape(spec) { const d = await getDrawing(); if (!d) return null; return d.drawShape(spec); },
  async removeOne(args) { const d = await getDrawing(); if (!d) return null; return d.removeOne(args); },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'drawings.json');

function load() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    return { version: 1, setups: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!raw?.setups) return { version: 1, setups: {} };
    return raw;
  } catch { return { version: 1, setups: {} }; }
}

const state = load();
setInterval(prune, 6 * 60 * 60 * 1000).unref();

function flush() {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.warn('drawings flush failed', { err: err.message });
  }
}

function prune() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [k, v] of Object.entries(state.setups)) {
    if ((v.updatedAt || 0) < cutoff) {
      delete state.setups[k];
      removed++;
    }
  }
  if (removed > 0) flush();
}

// ---------- shape spec → MCP draw call ----------

function colorForDir(direction) {
  return direction === 'LONG' ? '#26a69a' : direction === 'SHORT' ? '#ef5350' : '#ff9800';
}

function fillRgbaFor(direction, alpha = 0.18) {
  if (direction === 'LONG') return `rgba(38,166,154,${alpha})`;
  if (direction === 'SHORT') return `rgba(239,83,80,${alpha})`;
  return `rgba(255,152,0,${alpha})`;
}

async function tryDraw(spec) {
  try {
    const r = await drawing.drawShape(spec);
    return r?.entity_id || null;
  } catch (err) {
    log.warn('drawShape failed', { spec: { shape: spec.shape }, err: err.message });
    return null;
  }
}

async function tryRemove(entityId) {
  try {
    await drawing.removeOne({ entity_id: entityId });
    return true;
  } catch (err) {
    // Often "entity not found" if user deleted manually — fine, swallow
    return false;
  }
}

/**
 * Build a list of shape specs for the current phase of a setup.
 * Each spec is independently drawable via drawing.drawShape().
 */
function buildSpecs(result, nowUnix) {
  const specs = [];
  const g = result.geometry;
  if (!g) return specs;
  const tAnchor = nowUnix; // anchor time used by horizontal_line
  const tagPrefix =
    result.strategy === 'USLS' ? 'S1' :
    result.strategy === 'ICT-SMC' ? 'S2' :
    result.strategy === 'ALGO-SMC' ? 'S3' :
    result.strategy === 'ADAPTIVE' ? 'S4' :
    result.strategy === 'ICT' ? 'S5' :
    result.strategy === 'SMT' ? 'S6' :
    result.strategy === 'TRINITY' ? 'S7' :
    result.strategy.slice(0, 3).toUpperCase();
  const dirColor = colorForDir(result.direction);

  // ----- target liquidity level (always drawn)
  if (g.target) {
    const c = result.status === 'forming' && !g.sweep ? '#999999' : '#cccccc';
    specs.push({
      key: 'target',
      shape: 'horizontal_line',
      point: { time: tAnchor, price: g.target.level },
      overrides: JSON.stringify({ linecolor: c, linewidth: 1, linestyle: 2 }),
    });
    specs.push({
      key: 'target_lbl',
      shape: 'text',
      point: { time: tAnchor, price: g.target.level },
      text: `${tagPrefix} ${g.target.name}`,
      overrides: JSON.stringify({ color: c, fontsize: 11 }),
    });
  }

  // ----- DOL target (for ICT-SMC)
  if (g.dol) {
    specs.push({
      key: 'dol',
      shape: 'horizontal_line',
      point: { time: tAnchor, price: g.dol.level },
      overrides: JSON.stringify({ linecolor: '#00bcd4', linewidth: 1, linestyle: 0 }),
    });
    specs.push({
      key: 'dol_lbl',
      shape: 'text',
      point: { time: tAnchor, price: g.dol.level },
      text: `${tagPrefix} DOL ${g.dol.name}`,
      overrides: JSON.stringify({ color: '#00bcd4', fontsize: 11 }),
    });
  }

  // ----- sweep wick
  if (g.sweep) {
    specs.push({
      key: 'sweep',
      shape: 'horizontal_line',
      point: { time: g.sweep.time, price: g.sweep.wickPrice },
      overrides: JSON.stringify({ linecolor: '#ff9800', linewidth: 1, linestyle: 0 }),
    });
    specs.push({
      key: 'sweep_lbl',
      shape: 'text',
      point: { time: g.sweep.time, price: g.sweep.wickPrice },
      text: `${tagPrefix} Sweep ${g.sweep.wickPrice.toFixed(2)}`,
      overrides: JSON.stringify({ color: '#ff9800', fontsize: 11 }),
    });
  }

  // ----- MSS broken pivot
  if (g.mss) {
    specs.push({
      key: 'mss',
      shape: 'horizontal_line',
      point: { time: g.mss.time, price: g.mss.brokenPrice },
      overrides: JSON.stringify({ linecolor: '#9c27b0', linewidth: 1, linestyle: 0 }),
    });
    specs.push({
      key: 'mss_lbl',
      shape: 'text',
      point: { time: g.mss.time, price: g.mss.brokenPrice },
      text: `${tagPrefix} MSS`,
      overrides: JSON.stringify({ color: '#9c27b0', fontsize: 11 }),
    });
  }

  // ----- 71% Fib line (Strategy #3)
  if (g.fib71 != null) {
    specs.push({
      key: 'fib71',
      shape: 'horizontal_line',
      point: { time: tAnchor, price: g.fib71 },
      overrides: JSON.stringify({ linecolor: '#ffeb3b', linewidth: 1, linestyle: 1 }),
    });
    specs.push({
      key: 'fib71_lbl',
      shape: 'text',
      point: { time: tAnchor, price: g.fib71 },
      text: `${tagPrefix} 71% Fib`,
      overrides: JSON.stringify({ color: '#ffeb3b', fontsize: 11 }),
    });
  }

  // ----- entry zone (FVG or OB), if available — drawn as rectangle from setup time to +200 bars
  const zone = g.fvg || g.ob;
  if (zone) {
    // Right edge ~50 bars forward of the anchor (heuristic) so the box is visible
    const right = tAnchor + 50 * 60 * 60; // big offset just to extend visibly; TV will show it
    specs.push({
      key: 'entry_zone',
      shape: 'rectangle',
      point: { time: zone.time, price: zone.top },
      point2: { time: right, price: zone.bottom },
      overrides: JSON.stringify({
        linecolor: dirColor,
        linewidth: 1,
        backgroundColor: fillRgbaFor(result.direction, 0.18),
        fillBackground: true,
      }),
    });
  }

  // ----- stop / TP / runner (triggered only)
  if (g.entryPlan) {
    const p = g.entryPlan;
    specs.push({
      key: 'sl',
      shape: 'horizontal_line',
      point: { time: tAnchor, price: p.stop },
      overrides: JSON.stringify({ linecolor: '#ef5350', linewidth: 2, linestyle: 0 }),
    });
    specs.push({
      key: 'sl_lbl',
      shape: 'text',
      point: { time: tAnchor, price: p.stop },
      text: `${tagPrefix} SL`,
      overrides: JSON.stringify({ color: '#ef5350', fontsize: 11 }),
    });
    specs.push({
      key: 'tp1',
      shape: 'horizontal_line',
      point: { time: tAnchor, price: p.t1 },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1, linestyle: 2 }),
    });
    specs.push({
      key: 'tp1_lbl',
      shape: 'text',
      point: { time: tAnchor, price: p.t1 },
      text: `${tagPrefix} TP1`,
      overrides: JSON.stringify({ color: '#26a69a', fontsize: 11 }),
    });
    specs.push({
      key: 'tp2',
      shape: 'horizontal_line',
      point: { time: tAnchor, price: p.t2 },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1, linestyle: 2 }),
    });
    specs.push({
      key: 'tp2_lbl',
      shape: 'text',
      point: { time: tAnchor, price: p.t2 },
      text: `${tagPrefix} TP2`,
      overrides: JSON.stringify({ color: '#26a69a', fontsize: 11 }),
    });
    if (p.runner != null) {
      specs.push({
        key: 'runner',
        shape: 'horizontal_line',
        point: { time: tAnchor, price: p.runner },
        overrides: JSON.stringify({ linecolor: '#4caf50', linewidth: 1, linestyle: 1 }),
      });
      specs.push({
        key: 'runner_lbl',
        shape: 'text',
        point: { time: tAnchor, price: p.runner },
        text: `${tagPrefix} Runner`,
        overrides: JSON.stringify({ color: '#4caf50', fontsize: 11 }),
      });
    }
  }

  return specs;
}

/** Remove all drawings for a setupId. Returns count removed. */
export async function removeAllForSetup(setupId) {
  const entry = state.setups[setupId];
  if (!entry || !entry.entityIds) return 0;
  let n = 0;
  for (const id of entry.entityIds) {
    if (await tryRemove(id)) n++;
  }
  delete state.setups[setupId];
  flush();
  return n;
}

/**
 * Sync TradingView drawings to match the current phase of a setup.
 * Idempotent — safe to call repeatedly with the same status.
 */
export async function syncDrawings(result) {
  if (!result?.setupId) return;
  const nowUnix = Math.floor(Date.now() / 1000);

  // Invalidation → wipe drawings
  if (result.status === 'invalidated') {
    const n = await removeAllForSetup(result.setupId);
    if (n > 0) log.info('drawings removed (invalidated)', { setupId: result.setupId, count: n });
    return;
  }

  // Don't draw anything for direction='NONE' alerts (HTF unknown, missing pane, etc.)
  if (!result.direction || result.direction === 'NONE') return;
  if (!result.geometry) return;

  // Compute desired shape specs
  const specs = buildSpecs(result, nowUnix);

  // Remove previous shapes for this setup
  const prev = state.setups[result.setupId];
  if (prev?.entityIds?.length) {
    for (const id of prev.entityIds) await tryRemove(id);
  }

  // Draw fresh
  const newIds = [];
  for (const spec of specs) {
    const id = await tryDraw({
      shape: spec.shape,
      point: spec.point,
      point2: spec.point2,
      text: spec.text,
      overrides: spec.overrides,
    });
    if (id) newIds.push(id);
  }

  state.setups[result.setupId] = {
    entityIds: newIds,
    lastStatus: result.status,
    strategy: result.strategy,
    direction: result.direction,
    updatedAt: Date.now(),
  };
  flush();
  log.info('drawings synced', {
    setupId: result.setupId,
    status: result.status,
    drawn: newIds.length,
    replaced: prev?.entityIds?.length || 0,
  });
}
