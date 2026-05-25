/**
 * TradingView bridge ingestion.
 *
 * The user's always-on Mac runs a small Node bridge (scripts/tv-bridge.js) that
 * reads live OHLCV bars from a local TradingView Desktop instance via the CDP
 * port, then POSTs them to the VPS bot. This module is the receiving side: a
 * shared in-memory cache + HMAC verification that both `webui/server.js`
 * (the HTTP endpoint) and `cloud/tradingview.js` (the data-source adapter)
 * import.
 *
 * Cache shape mirrors the rest of the cloud data pipeline so the cloud
 * adapter is a thin pass-through:
 *   key: `${asset}|${tf}`  (asset ∈ gold|nasdaq|sp,  tf ∈ '5'|'60' etc.)
 *   value: { symbol, resolution, bars:[{time(sec),open,high,low,close,volume}], lastPushAt }
 *
 * Auth model: HMAC-SHA256(secret, `${timestamp}.${body}`) as hex; rejection if
 * the bridge clock is >120s off (replay defense). The shared secret lives in
 * the VPS .env as TV_BRIDGE_SECRET; the same value sits on the always-on Mac.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { beat as heartbeat } from './heartbeat.js';

// In-memory: key → { symbol, resolution, bars, lastPushAt }
const CACHE = new Map();

// Reject any push whose timestamp is more than this far from server now —
// stops replay of a captured POST and also tells us the bridge clock is bad.
const MAX_CLOCK_SKEW_MS = 120 * 1000;

// A pane is "fresh" only if a bridge push touched it within this window. After
// that, callers fall back to the next data source (Yahoo). The 60s threshold
// is intentionally permissive: the bridge pushes every ~3s, so even one short
// network blip is absorbed without falling back.
export const FRESH_WINDOW_MS = 60 * 1000;

function getSecret() {
  const s = process.env.TV_BRIDGE_SECRET;
  if (!s) throw new Error('TV_BRIDGE_SECRET not set on VPS — cannot verify bridge pushes');
  return s;
}

/**
 * Verify an incoming push from the Mac bridge.
 * @param {string} bodyText  raw request body as text
 * @param {string} timestamp  X-Bridge-Timestamp header (unix ms as string)
 * @param {string} signature  X-Bridge-Auth header (lowercase hex)
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function verifyPush(bodyText, timestamp, signature) {
  if (!timestamp || !signature) return { ok: false, status: 400, error: 'missing auth headers' };
  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) return { ok: false, status: 400, error: 'bad timestamp' };
  const skew = Math.abs(Date.now() - tsMs);
  if (skew > MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: `clock skew ${Math.round(skew/1000)}s exceeds ${MAX_CLOCK_SKEW_MS/1000}s` };
  }
  const expected = createHmac('sha256', getSecret()).update(`${timestamp}.${bodyText}`).digest('hex');
  // timingSafeEqual requires equal-length inputs; if the bridge sends a
  // truncated/garbage signature this short-circuits without leaking via timing.
  const given = String(signature).toLowerCase();
  if (given.length !== expected.length) return { ok: false, status: 401, error: 'bad signature length' };
  if (!timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return { ok: false, status: 401, error: 'bad signature' };
  }
  return { ok: true };
}

/**
 * Ingest a verified push. Replaces the cache entries for every key the bridge
 * supplied — the bridge is the source of truth for what TV currently knows.
 * @param {{at:number, bars:Record<string,{symbol?,resolution?,bars:Array}>}} payload
 * @returns {{ accepted: number, keys: string[] }}
 */
export function ingest(payload) {
  if (!payload || typeof payload.bars !== 'object') return { accepted: 0, keys: [] };
  const now = Date.now();
  const keys = [];
  for (const [key, pane] of Object.entries(payload.bars)) {
    if (!pane || !Array.isArray(pane.bars) || !pane.bars.length) continue;
    const bars = [];
    for (const b of pane.bars) {
      // Tolerant parsing — bridge may send numbers or strings depending on JSON encoding.
      const time = Number(b.time);
      const open = Number(b.open);
      const high = Number(b.high);
      const low = Number(b.low);
      const close = Number(b.close);
      const volume = Number(b.volume) || 0;
      if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
      bars.push({ time, open, high, low, close, volume });
    }
    if (!bars.length) continue;
    CACHE.set(key, {
      symbol: pane.symbol || key.split('|')[0],
      resolution: pane.resolution || key.split('|')[1],
      bars,
      lastPushAt: now,
    });
    keys.push(key);
  }
  if (keys.length) {
    heartbeat('tv-bridge', {
      keys: keys.length,
      last_push_at: now,
      bars_total: keys.reduce((a, k) => a + (CACHE.get(k)?.bars.length || 0), 0),
    });
  }
  return { accepted: keys.length, keys };
}

/** Read a single pane from the cache, or null if absent / stale. */
export function getPane(asset, tf) {
  const entry = CACHE.get(`${asset}|${tf}`);
  if (!entry) return null;
  if (Date.now() - entry.lastPushAt > FRESH_WINDOW_MS) return null;
  return entry;
}

/** Snapshot of cache health for the bot's /diagnose and webui dashboard. */
export function status() {
  const now = Date.now();
  const panes = [];
  for (const [key, entry] of CACHE) {
    panes.push({
      key,
      bars: entry.bars.length,
      lastPushAgeMs: now - entry.lastPushAt,
      fresh: (now - entry.lastPushAt) <= FRESH_WINDOW_MS,
    });
  }
  return { paneCount: panes.length, anyFresh: panes.some((p) => p.fresh), panes };
}
