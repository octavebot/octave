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
  // Merge process.env first (systemd EnvironmentFile delivers vars here on
  // Linux), then layer the file on top so file vals win if both are set.
  // If neither has the required keys, exit with a clear error.
  let fileEnv = {};
  if (existsSync(ENV_PATH)) {
    try { fileEnv = parseEnv(readFileSync(ENV_PATH, 'utf8')); } catch {}
  } else if (!process.env.TELEGRAM_BOT_TOKEN) {
    // No file AND no process env → genuinely missing
    console.error(`[config] missing credentials: no ${ENV_PATH} and no TELEGRAM_BOT_TOKEN in environment`);
    console.error('[config] create the .env file or pass env vars via systemd EnvironmentFile');
    process.exit(2);
  }
  // Propagate file vars into process.env so modules that read process.env.* directly
  // (e.g. lib/llm.js reaching for GEMINI_API_KEY / ANTHROPIC_API_KEY) see them too.
  for (const [k, v] of Object.entries(fileEnv)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return { ...process.env, ...fileEnv };
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

// OWNER_CHAT_ID is where private/risk/eval messages go (defaults to the
// owner's user-id since DMs with a bot use the user's id as chat id).
// TELEGRAM_CHAT_ID stays the group where friends receive signals.
const ownerChat = env.OCTAVE_OWNER_CHAT_ID || env.OCTAVE_OWNER_ID || env.TELEGRAM_CHAT_ID;

export const config = Object.freeze({
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),       // group: signals only
  telegramOwnerChatId: ownerChat,                     // owner: signals + risk/buttons + all bot replies
  pollIntervalMs: intOr('POLL_INTERVAL_MS', 3000),
  reconnectIntervalMs: intOr('RECONNECT_INTERVAL_MS', 30000),
  lockSymbol: env.LOCK_SYMBOL || '',
  logLevel: env.LOG_LEVEL || 'info',
});
