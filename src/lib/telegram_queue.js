/**
 * Persistent Telegram send queue.
 *
 * Every Telegram send goes through here. If the API call succeeds, great.
 * If it fails (network down, Telegram returning 502, rate limit), the
 * payload is appended to .octave-pending-tg.jsonl and a background drain
 * re-tries with exponential backoff.
 *
 * Result: alerts are never lost. When connectivity returns, the queued
 * messages are delivered in order.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const QUEUE_FILE = join(__dirname, '..', 'state', 'pending-tg.jsonl');
// Per-chat outgoing-message log used by /cleanup-group to find and delete
// the bot's old messages. One JSONL per chat id, last 500 entries kept.
const GROUP_MSG_LOG_DIR = join(__dirname, '..', 'state', 'tg-sent');

let draining = false;
let drainTimer = null;

function logGroupSend(chatId, messageId) {
  try {
    if (!existsSync(GROUP_MSG_LOG_DIR)) mkdirSync(GROUP_MSG_LOG_DIR, { recursive: true });
    const f = join(GROUP_MSG_LOG_DIR, `${chatId}.jsonl`);
    appendFileSync(f, JSON.stringify({ id: messageId, at: Date.now() }) + '\n');
  } catch {}
}

/**
 * Read the bot's recent outgoing message ids for a chat — used by
 * /cleanup-group to delete them.
 */
export function listSentToChat(chatId) {
  try {
    const f = join(GROUP_MSG_LOG_DIR, `${chatId}.jsonl`);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Clear the recorded log after a successful cleanup. */
export function clearSentLog(chatId) {
  try {
    const f = join(GROUP_MSG_LOG_DIR, `${chatId}.jsonl`);
    if (existsSync(f)) writeFileSync(f, '');
  } catch {}
}

function appendQueue(item) {
  try {
    mkdirSync(dirname(QUEUE_FILE), { recursive: true });
    appendFileSync(QUEUE_FILE, JSON.stringify(item) + '\n');
  } catch (err) {
    console.error('[tg-queue] append failed:', err.message);
  }
}

function readQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function writeQueue(items) {
  try {
    if (items.length === 0) {
      writeFileSync(QUEUE_FILE, '');
    } else {
      writeFileSync(QUEUE_FILE, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    }
  } catch (err) {
    console.error('[tg-queue] write failed:', err.message);
  }
}

async function tryTelegramCall(call) {
  // call = { method: 'sendMessage'|'sendPhoto'|'deleteMessage', token, body }
  const url = `https://api.telegram.org/bot${call.token}/${call.method}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call.body),
    });
    if (r.ok) {
      // Capture message_id so callers (e.g. cleanup logger) can use it.
      try { const j = await r.json(); return { ok: true, result: j.result }; }
      catch { return { ok: true }; }
    }
    const text = await r.text().catch(() => '');
    return { ok: false, status: r.status, body: text };
  } catch (err) {
    return { ok: false, status: 0, body: err.message };
  }
}

/**
 * Public API — send via Telegram, queueing on failure.
 *
 * @param {string} token
 * @param {'sendMessage'|'sendPhoto'} method
 * @param {object} body  the JSON payload to POST
 * @returns {Promise<boolean>}  true if delivered immediately, false if queued
 */
// Telegram caps sendMessage at 4096 chars and sendPhoto caption at 1024.
// Anything longer 400s with "message is too long" and tg-queue drops it as
// a permanent failure. Trim at a line boundary so the Markdown stays balanced.
const TG_LIMITS = { sendMessage: 4000, sendPhoto: 1000 };
function maybeTruncate(method, body) {
  const cap = TG_LIMITS[method];
  if (!cap) return body;
  const key = method === 'sendPhoto' ? 'caption' : 'text';
  const txt = body?.[key];
  if (typeof txt !== 'string' || txt.length <= cap) return body;
  const slice = txt.slice(0, cap);
  const cutAt = slice.lastIndexOf('\n');
  const trimmed = (cutAt > cap - 400 ? slice.slice(0, cutAt) : slice)
    + '\n\n_…(truncated — message exceeded Telegram length cap)_';
  return { ...body, [key]: trimmed };
}

export async function send(token, method, body) {
  body = maybeTruncate(method, body);
  let res = await tryTelegramCall({ token, method, body });
  if (res.ok) {
    // Best-effort log: if we just sent to the signal group, record the
    // message_id so /cleanup-group can delete it later. Failures here are
    // silent — never break delivery on a logging error.
    try {
      const msgId = res.result?.message_id;
      const chatId = body?.chat_id;
      if (msgId && chatId) logGroupSend(String(chatId), msgId);
    } catch {}
    return true;
  }

  // Markdown parse failure — Telegram's legacy Markdown is fragile and a
  // stray * / _ / ` in dynamic text (AI commentary, summaries) breaks the
  // whole message. Rather than drop it, resend as plain text so the content
  // still reaches the user; only the bold/italic formatting is lost.
  if (res.status === 400 && /can't parse entities/i.test(res.body || '') && body?.parse_mode) {
    const { parse_mode, ...plain } = body;
    res = await tryTelegramCall({ token, method, body: plain });
    if (res.ok) {
      console.warn('[tg-queue] markdown failed — delivered as plain text');
      return true;
    }
  }

  // Some failures are permanent — don't queue those (would loop forever).
  // 400 = bad request (invalid markdown, blocked user, etc.)
  // 403 = bot blocked by user
  if (res.status === 400 || res.status === 403) {
    console.error('[tg-queue] permanent failure, dropping:', res.status, res.body?.slice(0, 200));
    return false;
  }
  appendQueue({ token, method, body, queuedAt: Date.now(), attempts: 0 });
  console.warn('[tg-queue] queued (will retry):', res.status, res.body?.slice(0, 100));
  scheduleDrain(5000); // first retry in 5s
  return false;
}

function scheduleDrain(delayMs) {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(drainOnce, delayMs);
}

async function drainOnce() {
  if (draining) return;
  draining = true;
  try {
    const queue = readQueue();
    if (queue.length === 0) { draining = false; return; }
    const remaining = [];
    let nextBackoff = 5000;
    for (const item of queue) {
      const res = await tryTelegramCall(item);
      if (res.ok) {
        // Delivered — drop from queue
        continue;
      }
      if (res.status === 400 || res.status === 403) {
        // Permanent — drop
        continue;
      }
      // Failed again — bump attempts and re-queue
      item.attempts = (item.attempts || 0) + 1;
      // After 20 attempts give up (likely ~hours of failure)
      if (item.attempts > 20) {
        console.error('[tg-queue] dropping after 20 attempts');
        continue;
      }
      remaining.push(item);
      nextBackoff = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, Math.min(item.attempts, 10)));
    }
    writeQueue(remaining);
    if (remaining.length > 0) scheduleDrain(nextBackoff);
  } finally {
    draining = false;
  }
}

/** Kick off a drain attempt — call this on service start in case the queue is non-empty. */
export function startDrain() {
  scheduleDrain(2000);
}
