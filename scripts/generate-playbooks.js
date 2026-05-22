#!/usr/bin/env node
/**
 * Generate one PDF per strategy: playbook + latest backtest stats.
 *
 * Output: playbooks/<strategy-id>.pdf
 *
 * Usage: node scripts/generate-playbooks.js
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../src/lib/strategy_registry.js';
import { renderPdf, markdownToBlocks } from '../src/lib/pdf_writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const OUT_DIR = join(REPO, 'playbooks');
const STATS_FILE = join(REPO, 'src', 'state', 'backtest-stats.json');

function loadStats() {
  if (!existsSync(STATS_FILE)) return {};
  try {
    const j = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
    const byId = {};
    for (const r of j.rows || []) byId[r.id] = r;
    return { byId, days: j.days, generatedAt: j.generatedAt };
  } catch { return {}; }
}

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const reg = await loadRegistry();
  const stats = loadStats();
  let count = 0;

  for (const s of reg) {
    const blocks = markdownToBlocks(s.playbook || `# ${s.name}\n\n${s.concept}`);

    // Append a backtest-stats section if we have data for this strategy.
    const st = stats.byId?.[s.id];
    if (st && st.status !== 'NO-DATA') {
      blocks.push({ kind: 'rule' });
      blocks.push({ kind: 'h2', text: `Backtest Results (${stats.days || '?'}-day walk-forward)` });
      blocks.push({ kind: 'body', text: `Trades: ${st.trades}   ·   ${num(st.tradesPerDay, 2)} per day` });
      blocks.push({ kind: 'body', text: `Win rate: ${(st.winRate * 100).toFixed(0)}%   ·   Avg winner: ${num(st.avgWinR)} RR` });
      blocks.push({ kind: 'body', text: `Expectancy: ${num(st.avgR)} R per trade   ·   Profit factor: ${num(st.profitFactor)}` });
      blocks.push({ kind: 'body', text: `Result vs target (60% win, 1.2 RR): ${st.status}` });
    }

    blocks.push({ kind: 'spacer' });
    blocks.push({ kind: 'rule' });
    blocks.push({ kind: 'small', text: `Octave Trading Signals · Strategy ${s.id} · generated ${new Date().toISOString().slice(0, 10)}` });

    const pdf = renderPdf(blocks);
    const file = join(OUT_DIR, `${s.id}.pdf`);
    writeFileSync(file, pdf);
    count++;
    console.log(`  ✓ ${s.id.padEnd(18)} → playbooks/${s.id}.pdf (${pdf.length} bytes)`);
  }
  console.log(`\nGenerated ${count} playbook PDFs in playbooks/`);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });

function num(v, d = 2) {
  return (v == null || !isFinite(v)) ? '-' : Number(v).toFixed(d);
}
