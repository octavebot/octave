#!/usr/bin/env node
/**
 * One-shot Telegram pipeline test.
 *
 * Builds a synthetic, clearly-marked TEST signal card and posts it to the live
 * signal channel via the same Telegram API path the real alerter uses, then
 * reports the round-trip latency. No side effects in the bot's state (no follow-up
 * registered, no dedup entry written, no paper-trade) — we POST directly to
 * Telegram so the test exercises only what matters: card formatting + the
 * Telegram round trip.
 *
 * Uses a real live MGC (gold) price via OANDA so the levels look natural;
 * marks the card unmistakably as a test ("🧪 TEST — IGNORE 🧪").
 *
 * Usage:  node scripts/test-signal.js
 *
 * Requires env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (or telegramChatId in
 * config), OANDA_API_TOKEN (for live spot — optional, falls back to 4500).
 */

import { fetchBars as fetchOanda } from '../src/cloud/oanda.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) { console.error('Need TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID'); process.exit(1); }

// Pull a real live price so the synthetic levels look like a normal MGC signal.
async function livePrice() {
  try {
    const p = await fetchOanda('gold', '5', 1);
    const b = p?.bars?.[p.bars.length - 1];
    return b?.close ?? 4500;
  } catch { return 4500; }
}

function fmt(v) {
  if (v == null) return '?';
  if (Math.abs(v) >= 1000) return v.toFixed(2);
  return v.toFixed(2);
}

// Replicates the alerter's card format (same monospace levels block, same icon
// vocabulary) so what arrives in Telegram looks visually identical to a real
// signal — just with the TEST banner.
function buildCard({ price, direction, conf, riskUsd }) {
  const sign = direction === 'LONG' ? 1 : -1;
  const entry = price - sign * 0.5;     // limit just behind the current bar
  const stop = entry - sign * 3.0;      // 3-pt risk on micro gold
  const risk = Math.abs(entry - stop);
  const t1 = entry + sign * 1.2 * risk;
  const t2 = entry + sign * 1.8 * risk;
  const dirIcon = direction === 'LONG' ? '🟢' : '🔴';

  // Contracts at $10/pt for MGC, $250 budget → ceil to 1 contract.
  const dpp = 10;
  const perContract = risk * dpp;
  const contracts = Math.max(1, Math.floor(riskUsd / perContract));
  const sizeUsd = contracts * perContract;

  const lines = [];
  lines.push('🧪 *TEST SIGNAL — IGNORE* 🧪');
  lines.push('_Pipeline test from claude · do NOT trade this_');
  lines.push('');
  lines.push(`${dirIcon} *${direction} · MICRO GOLD*  \`MGC1!\``);
  lines.push(`_NY Fair-Value Gap_  ·  15m  ·  🟢 fillable now`);
  lines.push('');
  lines.push('```');
  lines.push(`Entry   ${fmt(entry - 0.18 * risk).padStart(10)} — ${fmt(entry + 0.18 * risk)}`);
  lines.push(`Stop    ${fmt(stop).padStart(10)}`);
  lines.push(`TP1     ${fmt(t1).padStart(10)}`);
  lines.push(`TP2     ${fmt(t2).padStart(10)}`);
  lines.push('```');
  lines.push(`📐 ${contracts}c (~$${Math.round(sizeUsd)})  ·  📊 ${Math.round(conf*100)}%  ·  💎 1:${(Math.abs(t2-entry)/risk).toFixed(1)}  ·  ⚠️ normal risk`);
  lines.push('');
  lines.push('  ✓ Pipeline test — Telegram + card render');
  lines.push('  ✓ Sent via test-signal.js, NOT the live detector');
  return lines.join('\n');
}

async function postTelegram(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'Markdown', disable_notification: true }),
  });
  const body = await res.json();
  return { ok: res.ok && body.ok, status: res.status, body };
}

const price = await livePrice();
const text = buildCard({ price, direction: 'LONG', conf: 0.72, riskUsd: 250 });

console.log('--- card ---');
console.log(text);
console.log('--- sending to Telegram ---');
const t0 = Date.now();
const r = await postTelegram(text);
const dt = Date.now() - t0;
console.log(`status=${r.status} ok=${r.ok} latency=${dt}ms`);
if (!r.ok) console.log('body:', JSON.stringify(r.body));
