import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_PATH = join(homedir(), '.config', 'trading-alerts', '.env');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error(`[config] missing credentials file: ${ENV_PATH}`);
    console.error('[config] create it from .env.example and chmod 600');
    process.exit(2);
  }
  return parseEnv(readFileSync(ENV_PATH, 'utf8'));
}

const env = loadEnv();

function required(key) {
  const v = env[key];
  if (!v) {
    console.error(`[config] required env var missing: ${key}`);
    process.exit(2);
  }
  return v;
}

function intOr(key, fallback) {
  const v = env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = Object.freeze({
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),
  pollIntervalMs: intOr('POLL_INTERVAL_MS', 3000),
  reconnectIntervalMs: intOr('RECONNECT_INTERVAL_MS', 30000),
  lockSymbol: env.LOCK_SYMBOL || '',
  logLevel: env.LOG_LEVEL || 'info',
});
