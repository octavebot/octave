/**
 * Live executor — fires triggered signals to a configurable webhook for
 * actual broker execution.
 *
 * INERT BY DEFAULT. Live execution requires THREE independent conditions
 * to all be true:
 *   1. The account's mode === 'live' (set via `/risk live`)
 *   2. brokerConfig.webhookUrl is set (via `/broker set-url <url>`)
 *   3. The signal passed risk_manager gates
 *
 * Even one missing → paper-only behavior. This belt-and-suspenders design
 * is intentional: a single misconfiguration can NEVER cause an accidental
 * live trade.
 *
 * Safety layers:
 *   - Per-account cooldown (30s default) prevents runaway firing on a flood
 *   - Retry once on transient network failure; never retry on 4xx (bad request)
 *   - Owner gets a Telegram DM on every live fire (success OR failure)
 *   - Every attempt logged to src/state/live-executions.jsonl
 *   - Webhook URL must be HTTPS (refuses http:// to prevent accidental config)
 */

import { log } from '../logger.js';
import { config } from '../config.js';
import { send as sendViaQueue } from './telegram_queue.js';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'broker-config.json');
const LOG_FILE = join(__dirname, '..', 'state', 'live-executions.jsonl');

// Default JSON template. Placeholders are {{key}} — replaced from signal data.
// Most webhook bridges (TradersPost, Pickmytrade, custom TV alerts) accept
// JSON with these fields. Override via /broker set-template.
const DEFAULT_TEMPLATE = {
  ticker:    '{{symbol}}',
  action:    '{{direction_lower}}',   // 'long' or 'short'
  quantity:  '{{contracts}}',
  price:     '{{entry}}',
  stop_loss: '{{stop}}',
  take_profit: '{{tp1}}',
  account:   '{{account_id}}',
  strategy:  '{{strategy}}',
};

const DEFAULT_CONFIG = {
  // Per-account webhook URLs. Single-account era → just 'user'.
  webhooks: { user: null },
  // JSON payload template (shared across accounts; account_id placeholder differentiates).
  template: DEFAULT_TEMPLATE,
  // Cooldown between fires per account (ms). Prevents runaway on flood.
  cooldownMs: 30_000,
  // Auth header (if your bridge needs one). e.g. "Bearer abc123".
  authHeader: null,
};

function loadConfig() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...raw, webhooks: { ...DEFAULT_CONFIG.webhooks, ...(raw.webhooks || {}) }, template: { ...DEFAULT_TEMPLATE, ...(raw.template || {}) } };
    // Schema migration: legacy 'auto' webhook → 'user' (single-account era).
    // If both are set, 'user' wins; 'auto' is dropped. If only 'auto' is set,
    // migrate it to 'user' so the wiring keeps working post-consolidation.
    if (merged.webhooks.auto) {
      if (!merged.webhooks.user) merged.webhooks.user = merged.webhooks.auto;
      delete merged.webhooks.auto;
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let _cfg = loadConfig();

function saveConfig() {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(_cfg, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.warn('live_executor saveConfig failed', { err: err.message });
  }
}

export function getConfig() { return JSON.parse(JSON.stringify(_cfg)); }

/**
 * Set a per-account webhook URL. Returns { ok, error? }.
 * Refuses non-HTTPS URLs to prevent accidental http:// config.
 */
export function setWebhook(accountId, url) {
  // Accept any account id present in ACCOUNT_IDS. 'auto' is silently aliased
  // to the canonical id ('user') for backward compatibility.
  const id = accountId === 'auto' ? 'user' : accountId;
  if (url === null || url === '' || url === 'off') {
    _cfg.webhooks[id] = null;
    saveConfig();
    return { ok: true, cleared: true };
  }
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'URL must be HTTPS' };
  _cfg.webhooks[id] = url;
  saveConfig();
  return { ok: true };
}

export function setAuthHeader(value) {
  _cfg.authHeader = value || null;
  saveConfig();
}

export function setCooldown(ms) {
  const n = Math.max(5_000, Math.min(300_000, Number(ms) || 30_000));
  _cfg.cooldownMs = n;
  saveConfig();
}

export function setTemplate(template) {
  if (typeof template !== 'object' || !template) return { ok: false, error: 'template must be JSON object' };
  _cfg.template = template;
  saveConfig();
  return { ok: true };
}

// Per-account cooldown tracking.
// Per-account last-fire timestamp for cooldown. Keys are added on demand —
// no need to hardcode the account set here.
const _lastFireAt = {};

function logFire(row) {
  try {
    if (!existsSync(dirname(LOG_FILE))) mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
  } catch { /* never throw from logger */ }
}

function fillTemplate(template, vars) {
  // Walk the template; substitute {{name}} tokens. Numbers pass through as
  // numbers (no string-wrapped numbers, which break some webhook receivers).
  const sub = (val) => {
    if (typeof val !== 'string') return val;
    const m = val.match(/^\{\{([a-z_]+)\}\}$/);
    if (m) return vars[m[1]] ?? val;
    return val.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => String(vars[k] ?? ''));
  };
  const out = {};
  for (const [k, v] of Object.entries(template)) out[k] = sub(v);
  return out;
}

/**
 * Tell the owner via Telegram about a live execution attempt.
 * Best-effort — never throws.
 */
async function notifyOwner(text) {
  try {
    await sendViaQueue(config.telegramBotToken, 'sendMessage', {
      chat_id: config.telegramOwnerChatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    log.warn('live_executor notifyOwner failed', { err: err.message });
  }
}

async function postWebhook(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

/**
 * Fire a signal to the configured webhook for `accountId`.
 *
 * Returns { fired: true/false, reason? }. NEVER throws into caller — every
 * error path catches and notifies the owner.
 */
export async function fireLive(accountId, signal, sizing) {
  try {
    const url = _cfg.webhooks[accountId];
    if (!url) return { fired: false, reason: 'no webhook configured' };
    // Cooldown
    const now = Date.now();
    if (now - (_lastFireAt[accountId] || 0) < _cfg.cooldownMs) {
      const remaining = Math.ceil((_cfg.cooldownMs - (now - _lastFireAt[accountId])) / 1000);
      const reason = `cooldown active (${remaining}s remaining)`;
      logFire({ event: 'cooldown-skip', accountId, setupId: signal.setupId, reason });
      return { fired: false, reason };
    }
    _lastFireAt[accountId] = now;

    const vars = {
      symbol:          signal.symbol || signal.instrument,
      instrument:      signal.instrument,
      direction:       signal.direction,
      direction_lower: (signal.direction || '').toLowerCase(),
      contracts:       sizing?.contracts || 0,
      entry:           signal.entryPlan?.entry,
      stop:            signal.entryPlan?.stop,
      tp1:             signal.entryPlan?.t1,
      tp2:             signal.entryPlan?.t2,
      risk_usd:        sizing?.riskUsdActual || 0,
      account_id:      accountId,
      setup_id:        signal.setupId,
      strategy:        signal.strategy,
      confidence:      signal.confidence,
      timeframe:       signal.timeframe,
    };
    const payload = fillTemplate(_cfg.template, vars);
    const headers = _cfg.authHeader ? { authorization: _cfg.authHeader } : {};

    // First attempt
    let res = await postWebhook(url, payload, headers).catch((err) => ({ ok: false, status: 0, body: err.message }));
    // Retry once on transient (non-4xx) failure
    if (!res.ok && (res.status === 0 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await postWebhook(url, payload, headers).catch((err) => ({ ok: false, status: 0, body: err.message }));
    }

    logFire({
      event: res.ok ? 'fired' : 'failed',
      accountId, setupId: signal.setupId, strategy: signal.strategy,
      payload, status: res.status, body: res.body,
    });

    if (res.ok) {
      await notifyOwner([
        '🚀 *LIVE EXECUTION*',
        `*${accountId.toUpperCase()}* · ${signal.strategy} · ${signal.direction} ${signal.instrument}`,
        `Contracts: ${sizing?.contracts}  ·  Risk: $${Math.round(sizing?.riskUsdActual || 0)}`,
        `Entry: \`${signal.entryPlan?.entry}\`  ·  SL: \`${signal.entryPlan?.stop}\`  ·  TP1: \`${signal.entryPlan?.t1}\``,
        `Webhook → HTTP ${res.status} ✓`,
      ].join('\n'));
      return { fired: true, status: res.status };
    } else {
      await notifyOwner([
        '⚠️ *LIVE EXECUTION FAILED*',
        `*${accountId.toUpperCase()}* · ${signal.strategy} · ${signal.direction} ${signal.instrument}`,
        `Webhook HTTP ${res.status}`,
        '```',
        (res.body || '(no body)').slice(0, 400),
        '```',
        '_Trade NOT executed. Paper trade remains for tracking._',
      ].join('\n'));
      return { fired: false, reason: `HTTP ${res.status}`, body: res.body };
    }
  } catch (err) {
    log.error('live_executor.fireLive threw', { err: err.message, stack: err.stack });
    return { fired: false, reason: err.message };
  }
}

/**
 * Test ping — fires a clearly-tagged "test" payload to the configured URL.
 * Used by `/broker test` so user can confirm wiring before going live.
 */
export async function testPing(accountId) {
  const url = _cfg.webhooks[accountId];
  if (!url) return { ok: false, error: 'no webhook configured for ' + accountId };
  const payload = {
    test: true,
    account: accountId,
    note: 'Octave test ping — NOT a real trade. Disregard.',
    timestamp: new Date().toISOString(),
  };
  const headers = _cfg.authHeader ? { authorization: _cfg.authHeader } : {};
  const res = await postWebhook(url, payload, headers).catch((err) => ({ ok: false, status: 0, body: err.message }));
  logFire({ event: 'test-ping', accountId, payload, status: res.status, body: res.body });
  return { ok: res.ok, status: res.status, body: res.body };
}
