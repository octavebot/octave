/**
 * LLM provider abstraction — Groq (preferred, free) or Gemini (fallback).
 *
 * Provider selection (first match wins):
 *   GROQ_API_KEY   → Llama 3.3 70B via Groq (free, 14400 req/day)
 *   GEMINI_API_KEY → Gemini Flash/Pro (free tier — often quota-blocked)
 *   else           → throws "no-llm-key" (caller shows a friendly fallback)
 *
 * Public surface (unchanged across providers):
 *   chatWithTools({ system, messages, tools, toolHandlers, maxRounds }) → text reply
 *   oneShot({ system, userParts, maxTokens })                            → text reply
 *
 * `tools` schema is Anthropic-style JSON schema. We translate to Gemini's
 * functionDeclaration shape or OpenAI's `tools` shape (Groq is OpenAI-compatible)
 * internally. `messages` follow Anthropic's role/content shape; each provider
 * gets its own converter.
 */

import { fetchWithTimeout } from './http.js';
// 30s ceiling per LLM call — generous for inference, but a hung provider must
// never wedge a caller. (Only user left is strategy_extractor for /addstrategy;
// the live trading AI was removed.)
const fetch = (url, opts) => fetchWithTimeout(url, opts, 30000);

const GROQ_MODEL = process.env.OCTAVE_GROQ_MODEL || 'llama-3.3-70b-versatile';
const GEMINI_MODEL = process.env.OCTAVE_GEMINI_MODEL || 'gemini-2.0-flash';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export function pickProvider() {
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

export function providerLabel() {
  const p = pickProvider();
  if (p === 'groq') return `Groq ${GROQ_MODEL.replace('-versatile','').replace('llama-','Llama ')}`;
  if (p === 'gemini') return `Gemini ${GEMINI_MODEL.includes('pro') ? 'Pro' : 'Flash'}`;
  return 'offline';
}

// ────────────────────────────────────────────────────────────────────────
// chatWithTools — multi-turn tool-use loop
// ────────────────────────────────────────────────────────────────────────

export async function chatWithTools({ system, messages, tools, toolHandlers, maxRounds = 6 }) {
  const provider = pickProvider();
  if (!provider) throw new Error('no-llm-key');
  if (provider === 'groq') {
    try {
      return await _groqChat({ system, messages, tools, toolHandlers, maxRounds });
    } catch (err) {
      // Only fall back to Gemini on transient SERVER faults (5xx). 429 means
      // we're quota-throttled and Gemini's much smaller free tier will throw
      // the same error a moment later — better to surface the Groq quota
      // message and let the user wait/swap key.
      if (_isGroqServerFault(err) && process.env.GEMINI_API_KEY) {
        return _geminiChat({ system, messages, tools, toolHandlers, maxRounds });
      }
      throw err;
    }
  }
  return _geminiChat({ system, messages, tools, toolHandlers, maxRounds });
}

function _isGroqServerFault(err) {
  return /^Groq HTTP 5\d\d/.test(err?.message || '');
}

export function isQuotaError(err) {
  const m = err?.message || '';
  return /HTTP 429/.test(m) || /quota/i.test(m) || /rate.?limit/i.test(m);
}

// ── Groq (OpenAI-compatible) ────────────────────────────────────────────

async function _groqChat({ system, messages, tools, toolHandlers, maxRounds }) {
  // Translate Anthropic-style messages → OpenAI-style messages
  const oaMessages = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      oaMessages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const textParts = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolUses = m.content.filter((b) => b.type === 'tool_use');
      const msg = { role: 'assistant', content: textParts || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      }
      oaMessages.push(msg);
    } else if (m.role === 'user') {
      // user-role content array carries tool_result blocks; each becomes its own tool message
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          oaMessages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content || '') });
        } else if (b.type === 'text') {
          oaMessages.push({ role: 'user', content: b.text });
        }
      }
    }
  }

  // Translate Anthropic tools → OpenAI tools
  const oaTools = (tools || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  for (let round = 0; round < maxRounds; round++) {
    const body = {
      model: GROQ_MODEL,
      messages: oaMessages,
      max_tokens: 1024,
    };
    if (oaTools.length) { body.tools = oaTools; body.tool_choice = 'auto'; }

    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`Groq HTTP ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const choice = data?.choices?.[0]?.message;
    if (!choice) return '(no reply)';

    const text = choice.content || '';
    const calls = choice.tool_calls || [];

    // Persist this assistant turn back into the Anthropic-style messages array
    const assistantBlocks = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    for (const c of calls) {
      let input = {};
      try { input = JSON.parse(c.function.arguments || '{}'); } catch {}
      assistantBlocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
    }
    messages.push({ role: 'assistant', content: assistantBlocks });
    oaMessages.push(choice);

    if (calls.length === 0) {
      return text.trim() || '(no reply)';
    }

    // Execute tool calls, push tool_result for each
    const toolResultBlocks = [];
    for (const c of calls) {
      const handler = toolHandlers[c.function.name];
      let out;
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      try { out = handler ? await handler(args) : { error: `unknown tool: ${c.function.name}` }; }
      catch (err) { out = { error: err.message }; }
      const stringified = JSON.stringify(out).slice(0, 4000);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: c.id, content: stringified });
      oaMessages.push({ role: 'tool', tool_call_id: c.id, content: stringified });
    }
    messages.push({ role: 'user', content: toolResultBlocks });
  }
  return '_(stopped after tool round cap — try a more specific question)_';
}

// ── Gemini (kept as fallback) ───────────────────────────────────────────

async function _geminiChat({ system, messages, tools, toolHandlers, maxRounds }) {
  const functionDeclarations = (tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForGemini(t.input_schema),
  }));

  const contents = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }
    const parts = [];
    const role = m.role === 'assistant' ? 'model' : 'user';
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      else if (b.type === 'tool_result') {
        const prevModel = [...contents].reverse().find((c) => c.role === 'model');
        const prevCall = prevModel?.parts?.find((p) => p.functionCall)?.functionCall;
        const fnName = prevCall?.name || 'unknown';
        parts.push({ functionResponse: { name: fnName, response: { result: safeJson(b.content) } } });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }

  for (let round = 0; round < maxRounds; round++) {
    const body = { contents, systemInstruction: { parts: [{ text: system }] } };
    if (functionDeclarations.length) body.tools = [{ functionDeclarations }];
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const fnCalls = parts.filter((p) => p.functionCall);
    const textParts = parts.filter((p) => p.text).map((p) => p.text);

    const assistantBlocks = [];
    for (const t of textParts) assistantBlocks.push({ type: 'text', text: t });
    for (const fc of fnCalls) assistantBlocks.push({ type: 'tool_use', id: `gem_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, name: fc.functionCall.name, input: fc.functionCall.args || {} });
    messages.push({ role: 'assistant', content: assistantBlocks });
    contents.push({ role: 'model', parts });

    if (fnCalls.length === 0) return textParts.join('\n').trim() || '(no reply)';

    const toolResultBlocks = [];
    const responseParts = [];
    for (const fc of fnCalls) {
      const handler = toolHandlers[fc.functionCall.name];
      let out;
      try { out = handler ? await handler(fc.functionCall.args || {}) : { error: `unknown tool: ${fc.functionCall.name}` }; }
      catch (err) { out = { error: err.message }; }
      const stringified = JSON.stringify(out).slice(0, 4000);
      const lastAssistant = messages[messages.length - 1];
      const matchingId = lastAssistant.content.find((b) => b.type === 'tool_use' && b.name === fc.functionCall.name)?.id || 'unknown';
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: matchingId, content: stringified });
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: { result: safeJson(stringified) } } });
    }
    messages.push({ role: 'user', content: toolResultBlocks });
    contents.push({ role: 'user', parts: responseParts });
  }
  return '_(stopped after tool round cap — try a more specific question)_';
}

// ────────────────────────────────────────────────────────────────────────
// oneShot — single-call helper (used by strategy_extractor)
// ────────────────────────────────────────────────────────────────────────

export async function oneShot({ system, userParts, maxTokens = 1024 }) {
  const provider = pickProvider();
  if (!provider) throw new Error('no-llm-key');
  if (provider === 'groq') {
    try {
      return await _groqOneShot({ system, userParts, maxTokens });
    } catch (err) {
      if (_isGroqServerFault(err) && process.env.GEMINI_API_KEY) {
        return _geminiOneShot({ system, userParts, maxTokens });
      }
      throw err;
    }
  }
  return _geminiOneShot({ system, userParts, maxTokens });
}

async function _groqOneShot({ system, userParts, maxTokens }) {
  // Groq's standard Llama models don't have vision; non-text parts are dropped.
  // For PDF/image strategy extraction the caller will already have fallback
  // logic, so we just send whatever text we have.
  const text = userParts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n');
  const droppedMedia = userParts.some((p) => p.kind === 'image' || p.kind === 'document');
  const userContent = droppedMedia && !text
    ? '(image/document input — no vision on this model; replying based on filename and metadata only)'
    : text;

  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
  };
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Groq HTTP ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function _geminiOneShot({ system, userParts, maxTokens }) {
  const parts = userParts.map((p) => {
    if (p.kind === 'text') return { text: p.text };
    if (p.kind === 'image' || p.kind === 'document') return { inline_data: { mime_type: p.mediaType, data: p.base64 } };
    return null;
  }).filter(Boolean);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Gemini HTTP ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
  const clone = JSON.parse(JSON.stringify(schema));
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) return s.forEach(walk);
    if (typeof s.type === 'string') s.type = s.type.toUpperCase();
    delete s.$schema; delete s.additionalProperties; delete s.examples;
    for (const key of Object.keys(s)) walk(s[key]);
  };
  walk(clone);
  return clone;
}

function safeJson(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return { value: s }; }
}
