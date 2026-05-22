#!/usr/bin/env node
/**
 * Cloudflare Quick Tunnel URL watcher.
 *
 * Tails /home/octave/.octave-tunnel.log forever. When cloudflared prints a
 * fresh `https://*.trycloudflare.com` URL (which happens on every restart),
 * we:
 *   1. Write it to /home/octave/.octave-tunnel-url so the bot can read it
 *   2. Send a Telegram notification with the new URL
 *
 * Run via systemd:
 *   ExecStart=/usr/bin/node /home/octave/trading-alerts/scripts/tunnel-url-watcher.js
 *
 * No more "Cloudflare error 1033 — tunnel URL expired." The bot always
 * has the current URL.
 */

import { createReadStream, readFileSync, writeFileSync, existsSync, statSync, watchFile, chmodSync } from 'node:fs';
import { homedir } from 'node:os';

const LOG = '/home/octave/.octave-tunnel.log';
const URL_FILE = '/home/octave/.octave-tunnel-url';
const ENV_FILE = '/home/octave/.config/trading-alerts/.env';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let lastUrl = '';
try { lastUrl = readFileSync(URL_FILE, 'utf8').trim(); } catch {}

function loadCreds() {
  // Read the .env FILE first — it is the live source of truth. process.env
  // can hold a stale token from a systemd EnvironmentFile loaded at an old
  // start time (this is exactly what sent URLs to the retired bot).
  try {
    const env = Object.fromEntries(
      readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
    );
    const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
    const chat = (env.TELEGRAM_CHAT_ID || '').trim();
    if (token && chat) return { token, chat };
  } catch {}
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  }
  return { token: null, chat: null };
}

async function notify(newUrl) {
  const { token, chat } = loadCreds();
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: `🔄 *Dashboard URL refreshed*\n\n\`${newUrl}\`\n\nThe old link expired. Send /dashboard to open the new one.`,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error('[tunnel-watcher] notify failed:', err.message);
  }
}

function scanFileForLatestUrl() {
  if (!existsSync(LOG)) return null;
  try {
    const text = readFileSync(LOG, 'utf8');
    const matches = text.match(new RegExp(URL_RE.source, 'gi'));
    return matches ? matches[matches.length - 1] : null;
  } catch { return null; }
}

async function handleUrl(newUrl) {
  if (!newUrl || newUrl === lastUrl) return;
  console.log(`[tunnel-watcher] URL changed: ${lastUrl} → ${newUrl}`);
  lastUrl = newUrl;
  try {
    writeFileSync(URL_FILE, newUrl + '\n');
    // Mode 644 — readable by other users (e.g. ubuntu over SSH) so the
    // Mac Octave.app can fetch it. URL isn't sensitive.
    chmodSync(URL_FILE, 0o644);
  } catch (err) {
    console.error('[tunnel-watcher] could not write URL file:', err.message);
  }
  await notify(newUrl);
}

// Initial scan + write
const initial = scanFileForLatestUrl();
if (initial && initial !== lastUrl) handleUrl(initial);

// Poll the log file for changes — simpler and more reliable than tailing
console.log('[tunnel-watcher] watching', LOG);
watchFile(LOG, { interval: 3000 }, () => {
  const url = scanFileForLatestUrl();
  if (url) handleUrl(url);
});

// Also check every 30s in case watchFile misses an edit
setInterval(() => {
  const url = scanFileForLatestUrl();
  if (url) handleUrl(url);
}, 30_000);

process.on('uncaughtException', (err) => console.error('[tunnel-watcher] UNCAUGHT:', err.message));
process.on('unhandledRejection', (err) => console.error('[tunnel-watcher] UNHANDLED:', err?.message || err));
