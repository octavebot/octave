/**
 * Strategy extractor — takes an uploaded file (PDF, text, image, video, code)
 * and produces a user-strategy spec ready for user_strategies.create().
 *
 * Primary path: Gemini API. Reads PDFs, images, and text directly;
 * for video we extract a frame + transcript (best-effort) and feed that in.
 *
 * Fallback: regex heuristic that scans text for common trading rule phrases
 * (EMA, RSI, BB, TP, SL, ATR). Used when GEMINI_API_KEY is missing.
 *
 * The output is the same JSON schema the dashboard form produces, so the
 * downstream pipeline (validate → save → evaluate) doesn't need to care
 * how the spec was authored.
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { oneShot, pickProvider, providerLabel } from './llm.js';

const SCHEMA_PROMPT = `You are converting a trading strategy description into a strict JSON spec.

OUTPUT FORMAT (return ONLY this JSON, nothing else):
{
  "id": "kebab-case-id (a-z, 0-9, dashes, 2-40 chars)",
  "name": "Human Display Name (max 60 chars)",
  "description": "1-2 sentence summary of the strategy",
  "timeframe": "15" | "30" | "60" | "240",
  "direction": "auto" | "long" | "short",
  "entry": "ema_cross" | "ema_pullback" | "bb_extreme" | "rsi_bounds",
  "fast": <number 2..200>,
  "slow": <number 2..400, must be > fast>,
  "rsi_min": <number 0..100, gate longs only if RSI >= this; use 0 to disable>,
  "rsi_max": <number 0..100, gate shorts only if RSI <= this; use 100 to disable>,
  "stop_atr_mult": <number 0.1..10, how many ATRs the stop is from entry>,
  "tp_r": <number 0.5..20, take-profit as multiple of risk>
}

RULES:
- Pick the entry type whose description best matches the source:
  * ema_cross: "fast EMA crosses slow EMA", "9/21 cross", "MA crossover".
  * ema_pullback: "pullback to EMA", "retest of moving average", "wait for price to touch EMA + rejection".
  * bb_extreme: "Bollinger Band pierce", "extreme deviation from mean", "fade BB extremes".
  * rsi_bounds: "RSI oversold/overbought", "RSI mean reversion", "RSI < 30 bounce".
- If the source specifies a timeframe < 15m, snap to 15.
- If unsure about a numeric, use these safe defaults: fast=9, slow=21, rsi_min=0, rsi_max=100, stop_atr_mult=1.5, tp_r=2.
- If R:R is mentioned (e.g., "1:1.5 RR"), set tp_r to the right side of the ratio.
- id should be derived from the strategy name (lowercase, kebab).

Reply with ONLY the JSON object. No prose, no markdown fences.`;

/**
 * Public entry: extract a strategy spec from one uploaded file.
 *
 * @param {object} file  { buffer: Buffer, mimetype: string, filename: string }
 * @returns {Promise<{spec: object, source: 'gemini'|'heuristic', notes?: string}>}
 */
export async function extractStrategy(file) {
  const ext = extname(file.filename).toLowerCase();
  const mime = (file.mimetype || guessMime(ext)).toLowerCase();
  // For all paths, we collect either text content or a base64 image to send.
  // Text path covers .pdf (server-extracted), .txt, .md, .js, .py, etc.
  // Image path covers .png/.jpg → Claude vision.
  // Video path: best-effort frame snapshot via ffmpeg if available; else heuristic.

  const provider = pickProvider();
  if (!provider) {
    const text = await fileToText(file, mime);
    return { spec: heuristicParse(text, file.filename), source: 'heuristic',
             notes: 'No GEMINI_API_KEY set — used regex fallback. Get a free key at https://aistudio.google.com/apikey.' };
  }

  try {
    const userParts = await buildLlmParts(file, mime);
    const reply = await oneShot({ system: SCHEMA_PROMPT, userParts, maxTokens: 1024 });
    const json = parseFirstJson(reply);
    if (!json) throw new Error(`${providerLabel()} returned no JSON`);
    return { spec: json, source: provider };
  } catch (err) {
    // Fall back so the user still gets something
    const text = await fileToText(file, mime);
    return { spec: heuristicParse(text, file.filename), source: 'heuristic',
             notes: `${providerLabel()} extraction failed (${err.message}); used regex fallback.` };
  }
}

function guessMime(ext) {
  return {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.js': 'text/plain', '.py': 'text/plain', '.json': 'application/json',
  }[ext] || 'application/octet-stream';
}

/**
 * Build the provider-agnostic parts array for one file. The LLM wrapper
 * (llm.js) translates `kind` to the provider's native shape.
 */
async function buildLlmParts(file, mime) {
  const out = [];
  if (mime === 'application/pdf') {
    out.push({ kind: 'document', mediaType: 'application/pdf', base64: file.buffer.toString('base64') });
    out.push({ kind: 'text', text: `Extract a strategy spec from "${file.filename}".` });
    return out;
  }
  if (mime.startsWith('image/')) {
    out.push({ kind: 'image', mediaType: mime, base64: file.buffer.toString('base64') });
    out.push({ kind: 'text', text: `Extract a strategy spec from this image ("${file.filename}").` });
    return out;
  }
  if (mime.startsWith('video/')) {
    const frame = await tryFfmpegFrame(file);
    if (frame) {
      out.push({ kind: 'image', mediaType: 'image/jpeg', base64: frame.toString('base64') });
      out.push({ kind: 'text', text: `Single frame from "${file.filename}". If the frame doesn't contain a complete strategy, infer from any visible text.` });
      return out;
    }
    out.push({ kind: 'text', text: `Filename: ${file.filename}\n(Video could not be parsed — ffmpeg not available. Producing safe defaults from filename hints.)` });
    return out;
  }
  // Text-ish: include up to 24KB of decoded content
  const text = file.buffer.toString('utf8').slice(0, 24 * 1024);
  out.push({ kind: 'text', text: `Filename: ${file.filename}\n\n---\n${text}` });
  return out;
}

/** Try to grab a single representative frame via local ffmpeg. */
async function tryFfmpegFrame(file) {
  try {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'octave-vid-'));
    const inPath = join(dir, 'in' + extname(file.filename));
    const outPath = join(dir, 'frame.jpg');
    writeFileSync(inPath, file.buffer);
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-i', inPath, '-ss', '00:00:02', '-vframes', '1', '-vf', 'scale=1024:-1', outPath], { stdio: 'ignore' });
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg ' + code)));
      p.on('error', reject);
    });
    const buf = readFileSync(outPath);
    rmSync(dir, { recursive: true, force: true });
    return buf;
  } catch { return null; }
}

/**
 * Best-effort raw text from a file for the heuristic fallback. Works for
 * text files trivially; for PDFs we attempt a pdftotext shell-out if it's
 * on PATH (poppler-utils). Otherwise returns the filename as a last resort
 * so heuristicParse at least gets the strategy name from it.
 */
async function fileToText(file, mime) {
  if (mime.startsWith('text/') || mime === 'application/json') return file.buffer.toString('utf8');
  if (mime === 'application/pdf') {
    const text = await tryPdftotext(file).catch(() => null);
    if (text) return text;
  }
  // Image/video without Claude → all we have is the filename
  return basename(file.filename, extname(file.filename));
}

async function tryPdftotext(file) {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'octave-pdf-'));
  const inPath = join(dir, 'in.pdf');
  const outPath = join(dir, 'out.txt');
  writeFileSync(inPath, file.buffer);
  await new Promise((resolve, reject) => {
    const p = spawn('pdftotext', ['-layout', inPath, outPath], { stdio: 'ignore' });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('pdftotext ' + code)));
    p.on('error', reject);
  });
  const text = readFileSync(outPath, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return text;
}

/**
 * Extract the first JSON object from a Claude response. Defends against
 * code-fenced markdown wrappers ("```json\n...\n```").
 */
function parseFirstJson(s) {
  if (!s) return null;
  const clean = s.replace(/```(?:json)?/g, '').trim();
  // Find the first balanced { ... }
  let depth = 0, start = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (clean[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(clean.slice(start, i + 1)); } catch {}
        return null;
      }
    }
  }
  return null;
}

/**
 * Regex fallback: scan text for trading rule phrases and produce a
 * conservative spec. Works on simple strategy docs; sophisticated multi-leg
 * setups will get only the first interpretable signal.
 */
function heuristicParse(text, filename) {
  const t = String(text || '').toLowerCase();
  const baseId = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').slice(0, 40);

  // Determine entry type — first signal wins
  let entry = 'ema_cross';
  if (/(pull ?back|retest).*ema|ema.*pull ?back/i.test(text)) entry = 'ema_pullback';
  else if (/bollinger|2\.?5? ?sigma|2 ?sd|extreme|rubber band/i.test(text)) entry = 'bb_extreme';
  else if (/rsi.*(<|under|below)?\s?(30|40)\b|oversold|overbought/i.test(text)) entry = 'rsi_bounds';
  else if (/cross|crossover|crosses/i.test(t)) entry = 'ema_cross';

  // EMA periods — pick first two numbers near "ema"
  let fast = 9, slow = 21;
  const emaNums = [...t.matchAll(/(\d{1,3})\s?(?:ema|sma|ma)/g)].map((m) => +m[1]).filter((n) => n >= 3 && n <= 400);
  if (emaNums.length >= 2) { fast = Math.min(emaNums[0], emaNums[1]); slow = Math.max(emaNums[0], emaNums[1]); }
  if (fast >= slow) slow = fast * 2;

  // RR target (tp_r)
  let tp_r = 2;
  const rrMatch = t.match(/1\s?:\s?(\d+(\.\d+)?)\s?(rr|risk)/i) || t.match(/take ?profit:?\s?(\d+(\.\d+)?)\s?r/i);
  if (rrMatch) tp_r = Math.max(0.5, Math.min(20, parseFloat(rrMatch[1])));

  // TF — look for "15m chart", "1h", etc. Default 15.
  let tf = '15';
  if (/30 ?(min|m)|30-minute/i.test(text)) tf = '30';
  else if (/(1 ?h|60 ?(min|m)|hourly)/i.test(text)) tf = '60';
  else if (/(4 ?h|240 ?(min|m))/i.test(text)) tf = '240';

  // Name — first line longer than 10 chars or filename
  const firstLine = String(text).split('\n').map((l) => l.trim()).find((l) => l.length > 10 && l.length < 80);
  const name = firstLine || filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

  return {
    id: baseId || 'imported-strategy',
    name: name.slice(0, 60),
    description: 'Imported via file upload (heuristic parser).',
    timeframe: tf,
    direction: 'auto',
    entry,
    fast, slow,
    rsi_min: 0, rsi_max: 100,
    stop_atr_mult: 1.5, tp_r,
  };
}
