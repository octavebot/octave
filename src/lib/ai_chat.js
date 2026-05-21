/**
 * AI chat — Claude with tool use, talks to the bot in natural language.
 *
 * Routes any free-form Telegram message to Claude. Claude has a catalog of
 * tools that let it inspect the bot state (status, prices, bias, news,
 * journal) AND change it (log a trade, enable/disable strategies, run
 * backtests, fix services, create user strategies).
 *
 * Multi-turn tool loop: Claude returns tool_use blocks → we execute → return
 * tool_result → repeat until Claude answers in plain text. Caps at 6 tool
 * rounds so a runaway loop can't burn through tokens.
 */

import Anthropic from '@anthropic-ai/sdk';
import * as journal from './trade_journal.js';
import * as us from './user_strategies.js';
import * as fu from './follow_up.js';
import * as sh from './self_heal.js';
import * as news from './news.js';
import { load as loadCfg, save as saveCfg } from './runtime_config.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');

const MODEL = process.env.OCTAVE_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are Octave's in-bot assistant. The user runs a Telegram trading bot that
monitors Gold (MGC1!), Nasdaq (MNQ1!), and S&P (MES1!) micro-futures across
20+ strategies. Be concise, direct, and proactive.

ROLE
- Answer questions about the bot's state (prices, bias, news, active setups).
- Help the user log trades they're taking: when they entered, contracts used,
  if they hit TP, SL, moved to breakeven, etc. Use the journal_* tools.
- Make changes when asked: enable/disable strategies, fix broken services,
  create new user-defined strategies, run backtests.
- Suggest useful follow-ups (1-2 sentences max). e.g. after they log a trade,
  remind them what their plan was; after a /diagnose, suggest /fix.

STYLE
- Telegram. Use Markdown sparingly: *bold* for emphasis, \`code\` for ids/prices.
- Short. 3-5 lines is usually enough.
- Never invent prices or stats — call the right tool first.
- When you log a journal event, confirm what you wrote.
- The user's local time zone is America/New_York.

INSTRUMENTS
- gold = MGC1! Micro Gold
- nasdaq = MNQ1! Micro Nasdaq-100
- sp = MES1! Micro S&P 500

KNOWN COMMANDS (for context, you don't have to invoke them via tools — you
can just mention them to the user):
/menu /status /price /bias /news /strategies /enable <id> /disable <id>
/mystrategies /addstrategy /editstrategy /delstrategy
/backtest [id] [days] /fix [component] /diagnose
/in /out /be /journal — trade journal`;

const TOOLS = [
  // ─── State inspection ───
  {
    name: 'get_status',
    description: 'Octave health snapshot: enabled strategies, mute, session, news blackout, active follow-up setups.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_prices',
    description: 'Latest prices for all three instruments (MGC1!, MNQ1!, MES1!).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_bias',
    description: 'Multi-instrument directional bias from running the detector.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_news',
    description: 'Upcoming high-impact USD news + current ±30m blackout state.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'lookahead window, default 48' } },
      required: [],
    },
  },
  {
    name: 'list_strategies',
    description: 'All built-in + user strategies with their enabled state.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_active_setups',
    description: 'Open follow-up setups (triggered, not yet TP/SL).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  // ─── State changes ───
  {
    name: 'enable_strategy',
    description: 'Turn a strategy on.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'disable_strategy',
    description: 'Turn a strategy off.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_user_strategy',
    description: 'Create a new user-defined strategy. Use defaults for fields you do not know; the user can edit later.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' },
        description: { type: 'string' },
        timeframe: { type: 'string', enum: ['15', '30', '60', '240'] },
        direction: { type: 'string', enum: ['auto', 'long', 'short'] },
        entry: { type: 'string', enum: ['ema_cross', 'ema_pullback', 'bb_extreme', 'rsi_bounds'] },
        fast: { type: 'number' }, slow: { type: 'number' },
        stop_atr_mult: { type: 'number' }, tp_r: { type: 'number' },
      },
      required: ['id', 'name', 'entry'],
    },
  },
  // ─── Trade journal ───
  {
    name: 'journal_log_entry',
    description: 'Record that the user entered a trade. setupId can be any short identifier the user said (e.g. "my-ema-cross long").',
    input_schema: {
      type: 'object',
      properties: {
        setupId: { type: 'string' },
        instrument: { type: 'string', enum: ['gold', 'nasdaq', 'sp'] },
        strategy: { type: 'string' },
        contracts: { type: 'number' },
        price: { type: 'number' },
      },
      required: ['setupId', 'contracts', 'price'],
    },
  },
  {
    name: 'journal_log_exit',
    description: 'Record that the user closed a trade. reason: tp1/tp2/sl/be/manual.',
    input_schema: {
      type: 'object',
      properties: {
        setupId: { type: 'string' },
        reason: { type: 'string', enum: ['tp1', 'tp2', 'sl', 'be', 'manual'] },
        price: { type: 'number' },
        contracts: { type: 'number', description: 'partial size; omit if full close' },
      },
      required: ['setupId', 'reason', 'price'],
    },
  },
  {
    name: 'journal_log_be',
    description: 'Record that the user moved their stop to breakeven on this setup.',
    input_schema: { type: 'object', properties: { setupId: { type: 'string' } }, required: ['setupId'] },
  },
  {
    name: 'journal_log_note',
    description: 'Add a free-form note to a setup.',
    input_schema: {
      type: 'object',
      properties: { setupId: { type: 'string' }, text: { type: 'string' } },
      required: ['setupId', 'text'],
    },
  },
  {
    name: 'journal_recent',
    description: 'Return the last N journaled trades with their status.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'default 10' } },
      required: [],
    },
  },
  {
    name: 'journal_stats',
    description: 'Win rate + breakdown over the last N days.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'default 7' } },
      required: [],
    },
  },
  // ─── Ops ───
  {
    name: 'run_backtest',
    description: 'Run a backtest (slow — 5-30s). Returns headline stats only.',
    input_schema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', description: 'specific id or omit for all enabled' },
        days: { type: 'number', description: 'default 7' },
      },
      required: [],
    },
  },
  {
    name: 'diagnose',
    description: 'Run a health check on all services.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fix',
    description: 'Auto-heal a specific component or all (signal-engine, bot, webui, watchdog, market-data, git-sync, backtest, or "all").',
    input_schema: {
      type: 'object',
      properties: { component: { type: 'string' } },
      required: ['component'],
    },
  },
];

// ─── Tool implementations ───

const toolHandlers = {
  async get_status() {
    const cfg = loadCfg();
    const enabled = Object.entries(cfg.strategies || {}).filter(([, v]) => v).map(([k]) => k);
    const bo = news.checkBlackout(Date.now() / 1000, 30);
    return {
      enabledStrategies: enabled,
      totalStrategies: Object.keys(cfg.strategies || {}).length,
      muted: cfg.mute?.untilMs > Date.now(),
      bypassKillzones: !!cfg.bypassKillzones,
      newsBlackout: bo.blocked ? { event: bo.event?.title, minutesAway: bo.minutesAway } : null,
      activeSetups: fu.active().length,
    };
  },

  async get_prices() {
    const { fetchAllPanes } = await import('./cloud_data_supplement.js');
    const panes = await fetchAllPanes();
    const out = {};
    for (const inst of ['gold', 'nasdaq', 'sp']) {
      const p = panes.get(`${inst}|15`) || panes.get(`${inst}|5`);
      const last = p?.bars?.[p.bars.length - 1];
      const prev = p?.bars?.[p.bars.length - 25]; // ~6h ago for context
      if (last) out[inst] = { price: last.close, change: prev ? last.close - prev.close : null };
    }
    return out;
  },

  async get_bias() {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/run-detect-child.js'], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => out += c);
      child.on('exit', () => {
        try {
          const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
          const parsed = line ? JSON.parse(line.slice(7)) : { results: [] };
          const tally = { gold: { long: 0, short: 0 }, nasdaq: { long: 0, short: 0 }, sp: { long: 0, short: 0 } };
          for (const r of parsed.results || []) {
            if (!r.instrument || !tally[r.instrument]) continue;
            if (r.direction === 'LONG') tally[r.instrument].long++;
            else if (r.direction === 'SHORT') tally[r.instrument].short++;
          }
          resolve(tally);
        } catch (e) { resolve({ error: e.message }); }
      });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ error: 'timeout' }); }, 25_000);
    });
  },

  async get_news({ hours = 48 } = {}) {
    await news.refreshForexFactory().catch(() => {});
    const evs = news.upcomingEvents(Date.now() / 1000, hours);
    const bo = news.checkBlackout(Date.now() / 1000, 30);
    return {
      blackoutActive: bo.blocked,
      blackoutEvent: bo.event?.title || null,
      upcoming: evs.slice(0, 10).map((e) => ({
        title: e.title, unix: e.unix, minutesAway: Math.round((e.unix - Date.now() / 1000) / 60),
      })),
    };
  },

  async list_strategies() {
    const cfg = loadCfg();
    const userIds = us.list().map((s) => ({ id: s.id, name: s.name, entry: s.entry, kind: 'user' }));
    const builtIns = Object.keys(cfg.strategies || {})
      .filter((k) => !userIds.some((u) => u.id === k))
      .map((k) => ({ id: k, name: k, kind: 'builtin' }));
    return [...builtIns, ...userIds].map((s) => ({
      ...s, enabled: !!cfg.strategies?.[s.id],
    }));
  },

  async list_active_setups() {
    return fu.active().map((s) => ({
      setupId: s.setupId, strategy: s.strategy, instrument: s.instrument,
      direction: s.direction, entry: s.entry, stop: s.stop, t1: s.t1, t2: s.t2,
      createdAt: s.createdAt, milestones: Object.keys(s.milestonesFired || {}),
    }));
  },

  async enable_strategy({ id }) {
    const cfg = loadCfg(); cfg.strategies = cfg.strategies || {}; cfg.strategies[id] = true; saveCfg(cfg);
    return { ok: true, id, enabled: true };
  },

  async disable_strategy({ id }) {
    const cfg = loadCfg(); cfg.strategies = cfg.strategies || {}; cfg.strategies[id] = false; saveCfg(cfg);
    return { ok: true, id, enabled: false };
  },

  async create_user_strategy(spec) {
    try {
      const created = us.create({
        fast: 9, slow: 21, direction: 'auto', timeframe: '15',
        rsi_min: 0, rsi_max: 100, stop_atr_mult: 1.5, tp_r: 2,
        ...spec,
      });
      const cfg = loadCfg(); cfg.strategies = cfg.strategies || {}; cfg.strategies[created.id] = true; saveCfg(cfg);
      return { ok: true, strategy: created };
    } catch (err) { return { ok: false, error: err.message }; }
  },

  async journal_log_entry({ setupId, instrument, strategy, contracts, price }) {
    return journal.log({ action: 'in', setupId, instrument, strategy, contracts, price });
  },

  async journal_log_exit({ setupId, reason, price, contracts }) {
    return journal.log({ action: 'out', setupId, reason, price, contracts });
  },

  async journal_log_be({ setupId }) {
    return journal.log({ action: 'be', setupId });
  },

  async journal_log_note({ setupId, text }) {
    return journal.log({ action: 'note', setupId, text });
  },

  async journal_recent({ limit = 10 } = {}) {
    return journal.recentTrades(limit);
  },

  async journal_stats({ days = 7 } = {}) {
    return journal.stats(days);
  },

  async run_backtest({ strategy, days = 7 } = {}) {
    return new Promise((resolve) => {
      const args = ['scripts/run-backtest-child.js', '--days', String(days)];
      if (strategy) args.push('--strategy', strategy);
      const child = spawn(process.execPath, args, { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => out += c);
      child.on('exit', () => {
        const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
        try { resolve(line ? JSON.parse(line.slice(7)) : { error: 'no result' }); }
        catch { resolve({ error: 'parse fail' }); }
      });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ error: 'timeout' }); }, 120_000);
    });
  },

  async diagnose() { return sh.diagnoseAll(); },

  async fix({ component }) {
    if (!component || component === 'all') return sh.fixAll();
    return sh.fixOne(component);
  },
};

// ─── Multi-turn chat loop ───

/** Per-chat conversation history. Cap to last 12 turns to keep context small. */
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, []);
  return sessions.get(chatId);
}

export function clearSession(chatId) { sessions.delete(chatId); }

/**
 * Run a chat turn. Returns the final text reply for the user.
 * @param {string} chatId
 * @param {string} userText
 */
export async function chat(chatId, userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return `🤖 AI chat is offline — \`ANTHROPIC_API_KEY\` not set on the server.\n\nAdd it to ~/.config/trading-alerts/.env on the VPS then \`/fix bot\`.`;
  }
  const client = new Anthropic({ apiKey });
  const session = getSession(chatId);
  session.push({ role: 'user', content: userText });
  // Trim history — keep last 24 messages (12 round-trips)
  while (session.length > 24) session.shift();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: session,
    });
    // Collect assistant content into the session
    session.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      // Plain text reply — extract and return
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return text || '(no reply)';
    }

    // Execute every tool_use block in this response, append tool_results
    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const handler = toolHandlers[block.name];
      let result;
      try {
        result = handler ? await handler(block.input || {}) : { error: `unknown tool: ${block.name}` };
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
    session.push({ role: 'user', content: toolResults });
  }
  return '_(stopped after 6 tool rounds — try a more specific question)_';
}
