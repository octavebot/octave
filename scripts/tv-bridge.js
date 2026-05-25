#!/usr/bin/env node
/**
 * TradingView bridge — runs on the user's always-on Mac.
 *
 * Reads live OHLCV bars from a local TradingView Desktop instance via the
 * Chrome DevTools Protocol (port 9222), then POSTs them to the VPS endpoint
 * /api/ingest-bars on a configurable cadence. Each push is HMAC-signed so
 * the VPS can verify the bridge is the one that pushed it (TV_BRIDGE_SECRET
 * shared between this script's env and the VPS .env).
 *
 * Assumes the user has 2 TV tabs open, each showing one of MGC1! / MNQ1!
 * at the 5-minute timeframe. The bridge auto-discovers them by reading
 * the active symbol from each CDP target — order doesn't matter, they just
 * need to exist. Higher timeframes (15m) are aggregated from the 5m stream
 * before sending so the VPS receives both panes per symbol.
 *
 * Resilience: keeps a per-target CDP client, reconnects on disconnect,
 * exponential backoff on push failures, Telegram nudge if no successful
 * push for >5 minutes. Designed to survive TV restarts, network blips,
 * and Mac sleeps (won't survive Mac actually sleeping — TV pauses too).
 *
 * Required env:
 *   VPS_URL              base url of the VPS webui (e.g. http://1.2.3.4:7345)
 *   TV_BRIDGE_SECRET     64-hex shared secret matching the VPS .env
 *   TELEGRAM_BOT_TOKEN   (optional) for blind-alert messages
 *   TELEGRAM_CHAT_ID     (optional) chat for blind alerts (your own DM or the signal group)
 *
 * Optional env:
 *   TV_CDP_PORT          default 9222
 *   TV_POLL_MS           default 3000 (one cycle through all tabs every 3s)
 *   TV_BARS_PER_PUSH     default 200 (recent 5m bars per symbol per push)
 *   TV_BLIND_ALERT_MS    default 5*60*1000 (alert if pushes have failed this long)
 *
 * Usage:
 *   node scripts/tv-bridge.js
 * Typically run via the LaunchAgent installed by scripts/install-tv-bridge.sh.
 */

import CDP from 'chrome-remote-interface';
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CDP_HOST = 'localhost';
const CDP_PORT = parseInt(process.env.TV_CDP_PORT || '9222', 10);

// VPS URL can be overridden in-place via ~/.octave-bridge/vps-url so the
// user can update it without re-running the installer when the Cloudflare
// Quick Tunnel rotates (e.g. on a VPS reboot — the bot Telegrams the new URL).
const VPS_URL_FILE = join(homedir(), '.octave-bridge', 'vps-url');
function currentVpsUrl() {
  try {
    if (existsSync(VPS_URL_FILE)) {
      const f = readFileSync(VPS_URL_FILE, 'utf8').trim();
      if (f) return f.replace(/\/$/, '');
    }
  } catch {}
  return (process.env.VPS_URL || '').replace(/\/$/, '');
}
const SECRET = process.env.TV_BRIDGE_SECRET;
const POLL_MS = parseInt(process.env.TV_POLL_MS || '3000', 10);
// 400 5m bars ≈ 33h → 133 aggregated 15m bars, enough for the bias read's
// ~114-bar volatility-percentile window so bias can run on the TV feed too.
const BARS_PER_PUSH = parseInt(process.env.TV_BARS_PER_PUSH || '400', 10);
const BLIND_ALERT_MS = parseInt(process.env.TV_BLIND_ALERT_MS || String(5 * 60 * 1000), 10);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

if (!currentVpsUrl() || !SECRET) {
  console.error('[tv-bridge] missing required env: VPS_URL (env or ~/.octave-bridge/vps-url) and TV_BRIDGE_SECRET');
  process.exit(2);
}

// Maps a TV symbol like "MGC1!" to the internal asset key the bot uses.
const SYMBOL_TO_ASSET = {
  'MGC1!': 'gold',
  'MNQ1!': 'nasdaq',
  // Tolerate the prefixed exchange forms TV sometimes returns
  'COMEX:MGC1!': 'gold',
  'CME_MINI:MNQ1!': 'nasdaq',
};

// Lifted from the TradingView MCP — internal path to the in-memory bars buffer.
const BARS_PATH = 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()';
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// The exact charts the bot needs. The bridge enforces these on every tab so
// the always-on Mac is fully turn-key — no manual chart setup, and it
// self-heals if TradingView resets a chart or reopens to a default symbol.
const REQUIRED = [
  { symbol: 'MGC1!', asset: 'gold' },
  { symbol: 'MNQ1!', asset: 'nasdaq' },
];
const REQUIRED_TF = '5';

// One CDP client per TV tab; key = CDP target.id
const clients = new Map();

let lastSuccessAt = Date.now();
let blindAlertSent = false;

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function errlog(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

async function listTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page' && /tradingview/i.test(t.url || ''));
}

async function connectTarget(target) {
  const existing = clients.get(target.id);
  if (existing) {
    try {
      await existing.Runtime.evaluate({ expression: '1', returnByValue: true });
      return existing;
    } catch {
      try { await existing.close(); } catch {}
      clients.delete(target.id);
    }
  }
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  clients.set(target.id, client);
  return client;
}

async function evalJS(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'CDP eval exception');
  return result?.value;
}

// Returns the symbol the chart in this tab is showing, or null if unreadable.
async function getTabSymbol(client) {
  try {
    return await evalJS(client, `(function(){ try { return ${BARS_PATH.replace('.bars()', '')}.symbol(); } catch(e) { return null; } })()`);
  } catch { return null; }
}

// Returns last N closed bars as [{ time, open, high, low, close, volume }, ...]
async function getTabBars(client, count) {
  return await evalJS(client, `
    (function() {
      try {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${count} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
        }
        return result;
      } catch (e) { return { __err: String(e) }; }
    })()
  `);
}

async function getTabResolution(client) {
  try { return String(await evalJS(client, `(function(){ try { return ${CHART_API}.resolution(); } catch(e){ return null; } })()`)); }
  catch { return null; }
}

async function setTabSymbol(client, symbol) {
  await evalJS(client, `
    (function() {
      try { ${CHART_API}.setSymbol(${JSON.stringify(symbol)}, {}); return true; } catch(e) { return false; }
    })()
  `);
}

async function setTabResolution(client, tf) {
  await evalJS(client, `
    (function() {
      try { ${CHART_API}.setResolution(${JSON.stringify(tf)}, {}); return true; } catch(e) { return false; }
    })()
  `);
}

// Make the open tabs show exactly the symbols the bot needs, each at 5m. This
// is what makes the Mac turn-key: the user never has to set up charts, and if
// TradingView reopens to a default chart after an update/restart, the bridge
// fixes it within one cycle. Strategy: figure out which required symbols are
// already covered, then assign each missing one to a tab that isn't showing a
// required symbol. Tabs are matched by CDP target id (stable within a session).
async function ensureCharts(targets) {
  // Read current symbol per target.
  const state = [];
  for (const t of targets) {
    let client;
    try { client = await connectTarget(t); } catch { continue; }
    const symbol = await getTabSymbol(client);
    const base = (symbol || '').split(':').pop();
    state.push({ target: t, client, base });
  }
  if (!state.length) return;

  const covered = new Set(state.map((s) => s.base).filter((b) => REQUIRED.some((r) => r.symbol === b)));
  const missing = REQUIRED.filter((r) => !covered.has(r.symbol));
  // Tabs not already showing a required symbol are free to reassign.
  const freeTabs = state.filter((s) => !REQUIRED.some((r) => r.symbol === s.base));

  for (const req of missing) {
    const tab = freeTabs.shift();
    if (!tab) {
      errlog(`cannot place ${req.symbol} — only ${state.length} TV tab(s) open, need ${REQUIRED.length}. Open more tabs in TradingView.`);
      continue;
    }
    log(`setting a tab to ${req.symbol} @ ${REQUIRED_TF}m (was ${tab.base || 'unknown'})`);
    try {
      await setTabSymbol(tab.client, req.symbol);
      await new Promise((r) => setTimeout(r, 800));
      await setTabResolution(tab.client, REQUIRED_TF);
      tab.base = req.symbol;
    } catch (err) { errlog(`failed to set ${req.symbol}:`, err.message); }
  }

  // Ensure every required tab is on the 5m timeframe.
  for (const s of state) {
    if (!REQUIRED.some((r) => r.symbol === s.base)) continue;
    const tf = await getTabResolution(s.client);
    if (tf !== REQUIRED_TF) {
      log(`fixing ${s.base} timeframe ${tf} → ${REQUIRED_TF}m`);
      try { await setTabResolution(s.client, REQUIRED_TF); } catch {}
    }
  }
}

// 5m → 15m aggregation, bucket-aligned to the 15-minute UTC wall clock so it
// matches Yahoo's / Databento's bar boundaries (and the existing strategies).
function aggregate(bars, bucketSec) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = Math.floor(b.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function postBars(payload) {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  const vpsUrl = currentVpsUrl();
  const res = await fetch(`${vpsUrl}/api/ingest-bars`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Timestamp': ts, 'X-Bridge-Auth': sig },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`VPS POST ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

async function sendBlindAlert(reason) {
  if (!TG_TOKEN || !TG_CHAT || blindAlertSent) return;
  blindAlertSent = true;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: `⚠️ TV bridge has been unable to push to the VPS for ${Math.round(BLIND_ALERT_MS/60000)}min — bot will be on delayed Yahoo data until this clears.\n\nReason: ${reason}\nFix on the always-on Mac: open TradingView, verify the 2 charts (MGC1!/MNQ1! at 5m), then it should auto-recover.`,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) { errlog('blind alert post failed:', err.message); }
}

let lastEnsureAt = 0;
const ENSURE_EVERY_MS = 30 * 1000;

// Bridge auto-update: every 5 min, fast-forward the local trading-alerts repo
// from origin/main. If new commits affect this script or its scripts/ siblings,
// process.exit(0) and let the LaunchAgent (KeepAlive=true) restart with the
// fresh code. That way a fix I push to tv-bridge.js reaches the Mac with no
// manual git pull. Safe: skips on uncommitted local changes (ff-only merge);
// crashes are absorbed (errors never bring the bridge down).
let lastUpdateCheckAt = 0;
const UPDATE_EVERY_MS = 5 * 60 * 1000;
async function autoUpdate() {
  if (Date.now() - lastUpdateCheckAt < UPDATE_EVERY_MS) return;
  lastUpdateCheckAt = Date.now();
  try {
    const { execFileSync } = await import('node:child_process');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const repo = join(homedir(), 'trading-alerts');
    const gitArgs = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const before = gitArgs(['rev-parse', 'HEAD']);
    gitArgs(['fetch', '--quiet', 'origin', 'main']);
    const remote = gitArgs(['rev-parse', 'origin/main']);
    if (before === remote) return;
    let changed;
    try { changed = gitArgs(['diff', '--name-only', before, remote]); }
    catch { return; }
    try { gitArgs(['merge', '--ff-only', remote]); }
    catch (err) { errlog('auto-update: ff-merge failed (local diverged?) — skipping'); return; }
    // Restart only when changes actually touch the bridge surface — avoids
    // pointless restarts for VPS-only commits (src/lib, src/cloud, etc.).
    const touchesBridge = changed.split('\n').some((p) =>
      p === 'scripts/tv-bridge.js' || p === 'scripts/launch-tv-cdp.sh' ||
      p === 'scripts/install-tv-bridge.sh' || p === 'package.json');
    if (touchesBridge) {
      log(`auto-updated ${before.slice(0, 7)} → ${remote.slice(0, 7)} — exiting for LaunchAgent restart`);
      process.exit(0);
    } else {
      log(`auto-updated ${before.slice(0, 7)} → ${remote.slice(0, 7)} (no bridge files changed; staying up)`);
    }
  } catch (err) { errlog('auto-update skipped:', err.message); }
}

async function cycle() {
  // Self-update check first — if we're about to restart with new code, do it
  // BEFORE doing more work on this cycle.
  await autoUpdate();

  const targets = await listTargets();
  if (!targets.length) throw new Error('no TradingView CDP targets — is TV running with --remote-debugging-port=9222 and a chart open?');

  // Periodically enforce the required charts so the Mac stays turn-key without
  // hammering CDP on every 3s tick.
  if (Date.now() - lastEnsureAt > ENSURE_EVERY_MS) {
    try { await ensureCharts(targets); } catch (err) { errlog('ensureCharts failed:', err.message); }
    lastEnsureAt = Date.now();
  }

  const bars5mByAsset = {};
  for (const target of targets) {
    let client;
    try { client = await connectTarget(target); }
    catch (err) { errlog('cdp connect failed for', target.id, err.message); continue; }
    const symbol = await getTabSymbol(client);
    const asset = SYMBOL_TO_ASSET[symbol] || SYMBOL_TO_ASSET[(symbol || '').split(':').pop()];
    if (!asset) continue;
    const bars = await getTabBars(client, BARS_PER_PUSH);
    if (!Array.isArray(bars) || !bars.length) {
      errlog(`empty bars for ${symbol} — chart still loading?`);
      continue;
    }
    bars5mByAsset[asset] = { symbol, bars };
  }

  const assetKeys = Object.keys(bars5mByAsset);
  if (!assetKeys.length) throw new Error('no readable bars across all tabs');

  // Build the multi-pane payload: 5m as-read, 15m aggregated.
  const panes = {};
  for (const [asset, { symbol, bars }] of Object.entries(bars5mByAsset)) {
    panes[`${asset}|5`] = { symbol, resolution: '5', bars };
    panes[`${asset}|15`] = { symbol, resolution: '15', bars: aggregate(bars, 900) };
  }

  await postBars({ at: Date.now(), bars: panes });
  lastSuccessAt = Date.now();
  blindAlertSent = false;

  const summary = assetKeys.map((a) => {
    const last = bars5mByAsset[a].bars.slice(-1)[0];
    const ageSec = Math.round((Date.now() / 1000) - last.time);
    return `${a}=${last.close}(${ageSec}s)`;
  }).join('  ');
  log('pushed', assetKeys.length, 'symbols', summary);
}

let backoffMs = POLL_MS;
async function main() {
  log(`tv-bridge starting · CDP ${CDP_HOST}:${CDP_PORT} → VPS ${currentVpsUrl()} · poll ${POLL_MS}ms`);
  while (true) {
    try {
      await cycle();
      backoffMs = POLL_MS; // success: reset to normal cadence
    } catch (err) {
      errlog('cycle failed:', err.message);
      // After a failure, back off up to 60s so we don't hammer a dead VPS or TV.
      backoffMs = Math.min(backoffMs * 2, 60000);
      if ((Date.now() - lastSuccessAt) > BLIND_ALERT_MS) {
        await sendBlindAlert(err.message);
      }
    }
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

process.on('SIGTERM', () => { log('SIGTERM — exiting'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT — exiting'); process.exit(0); });

main().catch((err) => { errlog('fatal:', err.message, err.stack); process.exit(1); });
