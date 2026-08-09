// llm.js — standalone LLM client + agent loop for the whitespace harness.
// Self-contained: does NOT import anything from the PPT-generation harness. Talks to the same
// Anthropic-compatible endpoint (here: GLM) via env vars ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN.
// The agent loop is driven by a Registry (T: typed+validated tools) and a Context (C: bounded,
// compacted message history) — see tools.js and context.js.

const ANTHROPIC_VERSION = '2023-06-01';
const base = () => { const b = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, ''); if (!b) throw new Error('ANTHROPIC_BASE_URL not set'); return b; };
const token = () => { const t = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY; if (!t) throw new Error('ANTHROPIC_AUTH_TOKEN not set'); return t; };
// Strip a trailing context-window variant tag (e.g. "glm-5.2[1m]" → "glm-5.2"); the raw endpoint
// rejects the "[...]" suffix. Mirrors the same guard in lib/llm.js.
const stripVariantTag = (id) => (typeof id === 'string' ? id.replace(/\[[^\]]*\]$/, '') : id);
const resolveModel = (m) => {
  let id;
  if (!m || m === 'haiku') id = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
  else if (m === 'sonnet') id = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-5';
  else id = m;
  return stripVariantTag(id);
};
const textOf = (resp) => (Array.isArray(resp && resp.content) ? resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() : '');

async function raw(opts) {
  const url = base() + '/v1/messages';
  const body = { model: resolveModel(opts.model), max_tokens: opts.maxTokens || 1500, messages: opts.messages || [] };
  if (opts.system) body.system = opts.system;
  if (opts.tools && opts.tools.length) body.tools = opts.tools;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': token(), 'authorization': 'Bearer ' + token() },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('LLM HTTP ' + res.status + ': ' + t.slice(0, 400)); }
  return res.json();
}

async function ping(model) { return /pong/i.test(textOf(await raw({ model: model || 'haiku', maxTokens: 8, messages: [{ role: 'user', content: 'Reply: PONG' }] }))); }

// stable key-order-independent stringify for the result cache
function stableStringify(v) {
  if (v == null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/**
 * Agent loop. Uses a Registry (validated tools) and a Context (compacted history).
 * opts: { model, system, prompt, registry, context, maxSteps, maxTokens, isDone, onStep, __raw }
 */
async function agent(opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps || 12;
  const maxTokens = opts.maxTokens || 2048;
  const ctx = opts.context;               // Context (C)
  const reg = opts.registry;              // Registry (T)
  const call = opts.__raw || raw;
  const onStep = opts.onStep || (() => {});
  const isDone = opts.isDone || (() => false);
  const cache = new Map();
  const repeatN = new Map();
  let repeatedCalls = 0, noProgressTurns = 0;
  const toolCalls = [];

  ctx.setSystem(opts.system);
  ctx.pushUser(opts.prompt);

  const exec = async (tu) => {
    const key = tu.name + '\x00' + stableStringify(tu.input);
    if (cache.has(key)) {
      repeatedCalls++;
      const n = (repeatN.get(key) || 0) + 1; repeatN.set(key, n);
      onStep(tu.name, tu.input, '(cached repeat)');
      const note = n >= 1 ? `\n[system] 你第 ${n + 1} 次用相同参数调用 ${tu.name}，结果不变。请改换做法，或若已完成则调用 finish。` : '';
      return { content: cache.get(key) + note, isError: false, repeat: true };
    }
    const res = await reg.execute(tu.name, tu.input || {});   // T: validate + run
    let out = res.ok ? res.result : ('ERROR: ' + res.error);
    if (out.length > 4000) out = out.slice(0, 4000) + '\n[tool result truncated]';
    cache.set(key, out);
    toolCalls.push({ name: tu.name, input: tu.input });
    onStep(tu.name, tu.input, out);
    return { content: out, isError: !res.ok, repeat: false };
  };

  const gen = async (mt) => {
    let r = await call({ model: opts.model, system: ctx.system, messages: ctx.messages, tools: reg.apiList(), maxTokens: mt });
    const tus = (Array.isArray(r.content) ? r.content : []).filter((b) => b.type === 'tool_use');
    if (r.stop_reason === 'max_tokens' && tus.length && tus.some((t) => t.input == null))
      r = await call({ model: opts.model, system: ctx.system, messages: ctx.messages, tools: reg.apiList(), maxTokens: mt * 2 });
    return r;
  };

  for (let step = 0; step < maxSteps; step++) {
    const resp = await gen(maxTokens);
    const content = Array.isArray(resp.content) ? resp.content : [];
    const tus = content.filter((b) => b.type === 'tool_use');
    ctx.pushAssistant(content);
    if (resp.stop_reason !== 'tool_use' || !tus.length) return { text: textOf(resp), steps: step + 1, toolCalls, repeatedCalls, compactions: ctx.compactions };
    let anyNew = false;
    for (const tu of tus) {
      const id = tu.id || ('tu_' + step + '_' + Math.random().toString(36).slice(2, 8));
      const r = await exec(tu);
      ctx.pushToolResult(id, r.content, r.isError);   // C: compacted push
      if (!r.repeat) anyNew = true;
    }
    if (isDone()) return { text: '(done)', steps: step + 1, done: true, toolCalls, repeatedCalls, compactions: ctx.compactions };
    if (!anyNew) {
      noProgressTurns++;
      if (noProgressTurns >= 2) return { text: '(stopped: repeated tool calls)', steps: step + 1, truncated: true, reason: 'repeat-loop', toolCalls, repeatedCalls, compactions: ctx.compactions };
    } else noProgressTurns = 0;
  }
  return { text: '(max tool steps)', steps: maxSteps, truncated: true, reason: 'max-steps', toolCalls, repeatedCalls, compactions: ctx.compactions };
}

module.exports = { raw, agent, ping, textOf, resolveModel, stableStringify };
