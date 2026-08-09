// lib/llm.js — thin client over the Anthropic-compatible endpoint exposed by the
// runtime (here: Zhipu GLM at $ANTHROPIC_BASE_URL, Anthropic Messages API shape).
//
// Why this exists: the harness is otherwise a pure compiler/renderer. To make decks
// content-rich we let an LLM (a) gather real material via its built-in server-side web
// search, and (b) author a grounded outline. Both need one thing: call the LLM from Node.
//
// Zero new dependencies — uses global fetch (Node >= 18). Credentials come from the
// environment that already drives this Claude Code session:
//   ANTHROPIC_BASE_URL     e.g. https://open.bigmodel.cn/api/anthropic
//   ANTHROPIC_AUTH_TOKEN   bearer / x-api-key
//   ANTHROPIC_DEFAULT_HAIKU_MODEL  (fast/cheap — research, drafting)
//   ANTHROPIC_DEFAULT_SONNET_MODEL (higher quality — outline synthesis)
//   ANTHROPIC_DEFAULT_OPUS_MODEL
// Any of these can be overridden per-call via opts.model.

const ANTHROPIC_VERSION = '2023-06-01';

function base() {
  const b = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  if (!b) throw new Error('ANTHROPIC_BASE_URL not set — cannot call the LLM.');
  return b;
}
function token() {
  const t = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!t) throw new Error('ANTHROPIC_AUTH_TOKEN not set — cannot call the LLM.');
  return t;
}

// Resolve a model alias ("haiku"|"sonnet"|"opus") to a concrete model id from env, or
// pass through an explicit id. Defaults to the haiku-tier env model.
// Some runtimes expose context-window variants as a bracketed suffix on the model id — e.g.
// "glm-5.2[1m]" (Claude Code's 1M-context alias). The raw Anthropic-compatible endpoint rejects the
// tag ("[1214][modelCode 不存在]"), so strip a trailing "[...]" before calling the API.
function stripVariantTag(id) { return typeof id === 'string' ? id.replace(/\[[^\]]*\]$/, '') : id; }
function resolveModel(m) {
  let id;
  if (!m || m === 'haiku') id = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
  else if (m === 'sonnet') id = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-5';
  else if (m === 'opus') id = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-5';
  else id = m; // explicit id
  return stripVariantTag(id);
}

/**
 * Low-level call to the Messages API. Returns the parsed JSON response object.
 * opts: { model, system, messages, maxTokens, tools, temperature, search }
 *   - search:true  attaches Anthropic's server-side web_search tool (max 8 uses) so the
 *     model can browse. The response then contains server_tool_use + web_search_tool_result
 *     blocks in addition to the final text.
 */
async function raw(opts) {
  const url = base() + '/v1/messages';
  const body = {
    model: resolveModel(opts.model),
    max_tokens: opts.maxTokens || 1024,
    messages: opts.messages || [],
  };
  if (opts.system) body.system = opts.system;
  if (opts.temperature != null) body.temperature = opts.temperature;
  let tools = opts.tools ? opts.tools.slice() : null;
  if (opts.search) {
    tools = tools || [];
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: opts.search.max_uses || 8 });
  }
  if (tools) body.tools = tools;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      // Send both auth headers — Anthropic uses x-api-key; the GLM-compatible gateway also
      // accepts a bearer token. Harmless to include both, and maximises compatibility.
      'x-api-key': token(),
      'authorization': 'Bearer ' + token(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('LLM HTTP ' + res.status + ': ' + txt.slice(0, 500));
  }
  return res.json();
}

// Pull every text block out of a Messages response, concatenated. (Search responses have
// server_tool_use / web_search_tool_result blocks we ignore at the text level.)
function textOf(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Extract the gathered sources (title + url) from a search-enabled response, when present.
function sourcesOf(resp) {
  const out = [];
  if (!resp || !Array.isArray(resp.content)) return out;
  for (const b of resp.content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const c of b.content) {
        if (c && c.url) out.push({ title: c.title || '', url: c.url });
      }
    }
    // GLM's gateway sometimes returns generic tool_result blocks holding search JSON.
    if (b.type === 'tool_result' && b.content && typeof b.content === 'string') {
      const m = b.content.match(/'(?:link|url)':\s*'([^']+)'/g) || [];
      for (const mm of m.slice(0, 6)) {
        const u = mm.match(/'(?:link|url)':\s*'([^']+)'/);
        if (u) out.push({ title: '', url: u[1] });
      }
    }
  }
  return out;
}

/**
 * Ask the model a question, return its text answer.
 * opts: { model, system, prompt|messages, maxTokens, temperature, search }
 */
async function ask(opts) {
  const messages = opts.messages || [{ role: 'user', content: opts.prompt }];
  const resp = await raw({
    model: opts.model, system: opts.system, messages,
    maxTokens: opts.maxTokens, temperature: opts.temperature,
    search: opts.search ? { max_uses: opts.search.max_uses || 5 } : undefined,
  });
  return { text: textOf(resp), sources: sourcesOf(resp), raw: resp };
}

// Run several asks in parallel and settle them individually (one failure doesn't sink the
// batch — returns null for that item). Used by the research engine for multi-angle search.
async function askParallel(items, fn, concurrency) {
  concurrency = Math.max(1, concurrency || 4);
  const out = new Array(items.length).fill(null);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// --- strict JSON extraction -------------------------------------------------

const FENCE = /```(?:json|jsonc)?\s*([\s\S]*?)```/i;

function extractJson(text) {
  if (!text) return null;
  // 1) fenced code block
  const f = text.match(FENCE);
  let cand = f ? f[1] : text;
  // 2) first {...} or [...] span
  if (!cand.trim().startsWith('{') && !cand.trim().startsWith('[')) {
    const a = cand.indexOf('{'), b = cand.indexOf('[');
    const start = a === -1 ? b : (b === -1 ? a : Math.min(a, b));
    if (start > -1) {
      const open = cand[start], close = open === '{' ? '}' : ']';
      const end = cand.lastIndexOf(close);
      if (end > start) cand = cand.slice(start, end + 1);
    }
  }
  cand = cand.trim();
  // 3) strip trailing commas before }/]
  cand = cand.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cand); } catch { return null; }
}

/**
 * Ask the model for a JSON object. Parses leniently (fences, trailing commas, span-slicing).
 * On parse failure, makes ONE repair call quoting the bad output. Returns the parsed value
 * or throws if both attempts fail.
 * opts: { model, system, prompt, maxTokens, search, temperature }
 */
async function askJson(opts) {
  const sys = (opts.system ? opts.system + '\n\n' : '') +
    'CRITICAL: respond with ONE valid JSON object and NOTHING else — no prose, no markdown fences.';
  const first = await ask({
    model: opts.model, system: sys, prompt: opts.prompt,
    maxTokens: opts.maxTokens || 2048, temperature: opts.temperature,
    search: opts.search,
  });
  let val = extractJson(first.text);
  if (val !== null && typeof val === 'object') return val;

  const repair = await ask({
    model: opts.model, system: sys,
    prompt: 'Your previous output was not valid JSON. Output ONLY the corrected JSON object.\n\n' +
            'Previous output:\n' + first.text.slice(0, 2000) +
            '\n\nIf the intent is unclear, return {} .',
    maxTokens: opts.maxTokens || 2048, temperature: 0,
  });
  val = extractJson(repair.text);
  if (val !== null && typeof val === 'object') return val;
  throw new Error('LLM did not return valid JSON after retry. Tail: ' + repair.text.slice(-300));
}

// Quick self-check so misconfiguration fails loudly at startup, not mid-pipeline.
async function ping(model) {
  const r = await ask({ model: model || 'haiku', prompt: 'Reply with exactly: PONG', maxTokens: 8 });
  return /pong/i.test(r.text);
}

module.exports = { ask, askJson, askParallel, raw, textOf, sourcesOf, resolveModel, ping, extractJson, agent };

// stable (key-order-independent) JSON string for cache keys
function stableStringify(v) {
  if (v == null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/**
 * Tool-use agent loop (ReAct), Claude-Code-style robustness:
 *   - result cache: identical (tool, args) is run ONCE; repeats are served from cache (tools are
 *     treated as idempotent within a run — true for the read tools; side-effect tools like
 *     draw_red_box get de-duplicated too, since a redraw of the same box is a no-op);
 *   - loop guard: a turn that is ALL repeated calls nudges the model; two such turns in a row
 *     force-finish (prevents spinning on the same call until maxSteps);
 *   - unknown tool / thrown tool → tool_result with is_error:true (Anthropic failure signal);
 *   - opts.isDone(): if a tool signals completion (e.g. `finish`), stop right after — no extra round-trip.
 * opts: { model, system, prompt|messages, tools:[{name,description,input_schema,run}],
 *         maxSteps, maxTokens, onStep, isDone, __raw(test) }
 * Returns { text, steps, truncated, reason?, done?, toolCalls, repeatedCalls }
 */
async function agent(opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps || 12;
  const maxTokens = opts.maxTokens || 2048;
  const apiTools = (opts.tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const handlers = {};
  (opts.tools || []).forEach((t) => { handlers[t.name] = t.run; });
  const onStep = opts.onStep || (() => {});
  const isDone = opts.isDone || (() => false);
  const call = opts.__raw || raw; // test hook
  const cache = new Map();        // key -> output string
  const repeatN = new Map();      // key -> repeat count
  let repeatedCalls = 0, noProgressTurns = 0;
  const toolCalls = [];
  let messages = opts.messages || [{ role: 'user', content: opts.prompt }];

  const exec = async (tu) => {
    const key = tu.name + '\x00' + stableStringify(tu.input);
    if (cache.has(key)) {
      repeatedCalls++;
      const n = (repeatN.get(key) || 0) + 1; repeatN.set(key, n);
      onStep(tu.name, tu.input, '(cached repeat)');
      const note = n >= 1 ? `\n[system] 你第 ${n + 1} 次用相同参数调用 ${tu.name}，结果不变。请改换做法，或若已完成则调用 finish。` : '';
      return { content: cache.get(key) + note, isError: false, repeat: true };
    }
    let out, isError = false;
    if (!handlers[tu.name]) { out = 'ERROR: unknown tool "' + tu.name + '". Available: ' + Object.keys(handlers).join(', '); isError = true; }
    else { try { out = String(await handlers[tu.name](tu.input || {})); } catch (e) { out = 'ERROR: ' + e.message; isError = true; } }
    if (out.length > 4000) out = out.slice(0, 4000) + '\n[tool result truncated to keep context small]'; // Claude-Code-style context hygiene
    cache.set(key, out);
    toolCalls.push({ name: tu.name, input: tu.input });
    onStep(tu.name, tu.input, out);
    return { content: out, isError, repeat: false };
  };

  // generate one assistant turn; if a tool-use turn was truncated mid-block (max_tokens), retry
  // once with doubled tokens so the tool_use blocks come through complete.
  const gen = async (mt) => {
    let r = await call({ model: opts.model, system: opts.system, messages, tools: apiTools.length ? apiTools : undefined, maxTokens: mt });
    const tus = (Array.isArray(r.content) ? r.content : []).filter((b) => b.type === 'tool_use');
    if (r.stop_reason === 'max_tokens' && tus.length && tus.some((t) => t.input == null)) {
      r = await call({ model: opts.model, system: opts.system, messages, tools: apiTools.length ? apiTools : undefined, maxTokens: mt * 2 });
    }
    return r;
  };

  for (let step = 0; step < maxSteps; step++) {
    const resp = await gen(maxTokens);
    const content = Array.isArray(resp.content) ? resp.content : [];
    const tus = content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content });

    if (resp.stop_reason !== 'tool_use' || !tus.length) {
      return { text: textOf(resp), steps: step + 1, truncated: false, toolCalls, repeatedCalls };
    }
    const results = [];
    let anyNew = false;
    for (const tu of tus) {
      const r = await exec(tu);
      const tr = { type: 'tool_result', tool_use_id: tu.id, content: r.content };
      if (r.isError) tr.is_error = true;
      results.push(tr);
      if (!r.repeat) anyNew = true;
    }
    messages.push({ role: 'user', content: results });

    if (isDone()) return { text: '(done)', steps: step + 1, truncated: false, done: true, toolCalls, repeatedCalls };
    if (!anyNew) {
      noProgressTurns++;
      if (noProgressTurns >= 2) return { text: '(stopped: repeated tool calls, no progress)', steps: step + 1, truncated: true, reason: 'repeat-loop', toolCalls, repeatedCalls };
    } else noProgressTurns = 0;
  }
  return { text: '(reached max tool steps)', steps: maxSteps, truncated: true, reason: 'max-steps', toolCalls, repeatedCalls };
}
