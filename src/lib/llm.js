/**
 * LLM provider abstraction — Claude (paid) or Gemini (free) under one API.
 *
 * Provider selection (first match wins):
 *   ANTHROPIC_API_KEY → Claude Haiku 4.5
 *   GEMINI_API_KEY    → Gemini 2.0 Flash (free tier: 1500 req/day)
 *   else              → throws "no-llm-key" (caller shows a friendly fallback)
 *
 * Public surface:
 *   chatWithTools({ system, messages, tools, toolHandlers, maxRounds }) → text reply
 *   oneShot({ system, userParts, maxTokens })                            → text reply
 *
 * `tools` schema is provider-agnostic (Anthropic-style JSON schema). We
 * translate to Gemini's function-declaration shape internally.
 * `messages` follow Anthropic's role/content shape: { role, content } where
 * content is either a string or an array of typed blocks (text, tool_use,
 * tool_result). The Gemini path converts on the fly.
 */

const ANTHROPIC_MODEL = process.env.OCTAVE_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const GEMINI_MODEL = process.env.OCTAVE_GEMINI_MODEL || 'gemini-2.0-flash';

export function pickProvider() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

export function providerLabel() {
  const p = pickProvider();
  return p === 'anthropic' ? 'Claude Haiku' : p === 'gemini' ? 'Gemini Flash' : 'offline';
}

// ────────────────────────────────────────────────────────────────────────
// chatWithTools — multi-turn tool-use loop
// ────────────────────────────────────────────────────────────────────────

/**
 * Run a tool-using conversation until the model emits plain text.
 * Mutates `messages` so the caller can persist updated history.
 */
export async function chatWithTools({ system, messages, tools, toolHandlers, maxRounds = 6 }) {
  const provider = pickProvider();
  if (!provider) throw new Error('no-llm-key');
  if (provider === 'anthropic') return _claudeChat({ system, messages, tools, toolHandlers, maxRounds });
  return _geminiChat({ system, messages, tools, toolHandlers, maxRounds });
}

async function _claudeChat({ system, messages, tools, toolHandlers, maxRounds }) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  for (let round = 0; round < maxRounds; round++) {
    const resp = await client.messages.create({
      model: ANTHROPIC_MODEL, max_tokens: 1024, system, tools, messages,
    });
    messages.push({ role: 'assistant', content: resp.content });
    if (resp.stop_reason !== 'tool_use') {
      return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(no reply)';
    }
    const results = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const handler = toolHandlers[block.name];
      let out;
      try { out = handler ? await handler(block.input || {}) : { error: `unknown tool: ${block.name}` }; }
      catch (err) { out = { error: err.message }; }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 4000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return '_(stopped after tool round cap — try a more specific question)_';
}

async function _geminiChat({ system, messages, tools, toolHandlers, maxRounds }) {
  // Anthropic-style tools → Gemini functionDeclarations
  const functionDeclarations = (tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForGemini(t.input_schema),
  }));

  // Build Gemini `contents` from Anthropic-style messages. Pending tool_use
  // calls become functionCall parts; tool_result blocks become functionResponse.
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
        // Gemini wants a functionResponse with the original function name. We
        // didn't keep that mapping; piggy-back on the previous functionCall.
        const prevModel = [...contents].reverse().find((c) => c.role === 'model');
        const prevCall = prevModel?.parts?.find((p) => p.functionCall)?.functionCall;
        const fnName = prevCall?.name || 'unknown';
        parts.push({ functionResponse: { name: fnName, response: { result: safeJson(b.content) } } });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }

  for (let round = 0; round < maxRounds; round++) {
    const body = {
      contents,
      systemInstruction: { parts: [{ text: system }] },
    };
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

    // Persist this assistant turn into the Anthropic-style messages array
    // so callers can continue the conversation later.
    const assistantBlocks = [];
    for (const t of textParts) assistantBlocks.push({ type: 'text', text: t });
    for (const fc of fnCalls) assistantBlocks.push({ type: 'tool_use', id: `gem_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, name: fc.functionCall.name, input: fc.functionCall.args || {} });
    messages.push({ role: 'assistant', content: assistantBlocks });
    contents.push({ role: 'model', parts });

    if (fnCalls.length === 0) {
      return textParts.join('\n').trim() || '(no reply)';
    }

    // Execute tools, append functionResponse parts
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

/**
 * One-shot generate. `userParts` is the provider-agnostic array:
 *   [{ kind: 'text', text }, { kind: 'image', mediaType, base64 }, { kind: 'document', mediaType, base64 }]
 */
export async function oneShot({ system, userParts, maxTokens = 1024 }) {
  const provider = pickProvider();
  if (!provider) throw new Error('no-llm-key');
  if (provider === 'anthropic') return _claudeOneShot({ system, userParts, maxTokens });
  return _geminiOneShot({ system, userParts, maxTokens });
}

async function _claudeOneShot({ system, userParts, maxTokens }) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const content = userParts.map((p) => {
    if (p.kind === 'text') return { type: 'text', text: p.text };
    if (p.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } };
    if (p.kind === 'document') return { type: 'document', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } };
    return null;
  }).filter(Boolean);
  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content }],
  });
  return resp.content?.[0]?.type === 'text' ? resp.content[0].text : '';
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

/**
 * Gemini's function-call schema is JSON Schema-ish but rejects some Anthropic
 * conveniences (allowed extra keys, certain `$schema` references). Strip
 * unsupported fields so the same `tools` array works for both providers.
 */
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
  const clone = JSON.parse(JSON.stringify(schema));
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) return s.forEach(walk);
    // Map JSON-Schema type strings to Gemini's enum
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
