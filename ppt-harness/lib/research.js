// lib/research.js — the "gather from the web → aggregate → pick the most valuable" engine.
//
// This is the fix for "内容不够丰满": instead of writing a deck from the LLM's memory alone,
// we first collect real material through the model's built-in server-side web search, then
// distil it into a structured research brief. The outline composer then authors slides
// *grounded* in that brief — real numbers, real examples, real trends, each with a source.
//
// Pipeline:
//   topic
//     │
//     ▼  Phase A — parallel focused searches (one per "angle")
//   [ overview | data/stats | applications | trends | cases | challenges ]
//     │            each: web_search → 3-6 concrete findings with sources (JSON)
//     ▼  Phase B — one aggregation call (no search) merges + ranks → research brief
//   brief { topic, summary, themes[], stats[], examples[], trends[], challenges[], sources[] }
//
// depth: 'quick' (3 angles) | 'standard' (5, default) | 'deep' (7). Deeper = more material,
// slower, costlier. All phases report progress via onProgress(phase, detail).

const llm = require('./llm');

// Each angle: { key, label, ask } — `ask` returns the user prompt for this angle given topic.
// Angles are intentionally generic so any topic works (the harness stays topic-agnostic).
const ANGLES = {
  overview: {
    label: '概况与背景',
    ask: (t) => `关于「${t}」，搜索网络并回答：它是什么、为什么重要、当前处于什么发展阶段。` +
                `给出 3-6 条具体、有价值的信息点（不要泛泛而谈）。`,
  },
  data: {
    label: '关键数据与市场规模',
    ask: (t) => `关于「${t}」，搜索网络，找出最重要的数字与事实：市场规模、增长率、渗透率、` +
                `关键指标的量化数据、权威预测等。给出 3-6 条带具体数字的信息点，每条注明来源。`,
  },
  applications: {
    label: '核心应用与关键方向',
    ask: (t) => `关于「${t}」，搜索网络，梳理它的核心应用场景、关键组成部分、主要技术方向或产品形态。` +
                `给出 3-6 条具体信息点。`,
  },
  trends: {
    label: '趋势与未来展望',
    ask: (t) => `关于「${t}」，搜索网络，总结当前最值得关注的发展趋势与未来 1-3 年的展望。` +
                `给出 3-6 条具体信息点。`,
  },
  cases: {
    label: '典型案例与代表玩家',
    ask: (t) => `关于「${t}」，搜索网络，找出有代表性的案例、领军企业、明星产品或落地项目，` +
                `以及它们的亮点。给出 3-6 条具体信息点，每条注明出处。`,
  },
  challenges: {
    label: '挑战与风险',
    ask: (t) => `关于「${t}」，搜索网络，梳理面临的主要挑战、风险、局限或争议。` +
                `给出 3-6 条具体信息点。`,
  },
};

const DEPTH = {
  quick: ['overview', 'applications', 'trends'],
  standard: ['overview', 'data', 'applications', 'trends', 'cases'],
  deep: ['overview', 'data', 'applications', 'trends', 'cases', 'challenges'],
};

// One focused search. Returns { angle, findings:[{point, source, url}], raw }.
async function searchAngle(topic, angleKey, model) {
  const angle = ANGLES[angleKey];
  const j = await llm.askJson({
    model: model || 'haiku',
    search: { max_uses: 3 },
    maxTokens: 1200,
    system: 'You are a research analyst. Search the web for real, current, specific information. ' +
            'Prefer concrete facts, numbers, named entities and reputable sources over vague generalities.',
    prompt: angle.ask(topic) +
            '\n\nReturn JSON: {"findings":[{"point":"具体信息点（含数字/名称）","source":"来源名称（站点/机构）","url":"链接或空字符串"}]}. ' +
            'point 用中文，简洁但要有实质信息。url 尽量给真实链接，找不到就空字符串。',
  });
  const findings = Array.isArray(j.findings) ? j.findings : [];
  return { angle: angleKey, label: angle.label, findings };
}

// Dedupe sources by URL (case-insensitive, trailing-slash-insensitive).
function normUrl(u) { return String(u || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase(); }
function mergeSources(lists) {
  const seen = new Set(), out = [];
  for (const s of lists.flat()) {
    if (!s || (!s.url && !s.source)) continue;
    const key = normUrl(s.url) || String(s.source || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: s.source || s.title || '', url: s.url || '' });
  }
  return out;
}

/**
 * Run the full research pipeline for a topic.
 * opts: { depth:'standard'|'quick'|'deep', model, onProgress, lang }
 *   onProgress(phase, detail) -> called with human-readable status lines.
 * Returns the research brief object.
 */
async function research(topic, opts) {
  opts = opts || {};
  const depth = DEPTH[opts.depth] ? opts.depth : 'standard';
  const model = opts.model || 'haiku';
  const onProgress = opts.onProgress || (() => {});
  topic = String(topic || '').trim() || '演示主题';

  const keys = DEPTH[depth];
  onProgress('research', `开始研究「${topic}」（${depth} 模式，${keys.length} 个维度联网检索）…`);

  // ---- Phase A: parallel focused searches ---------------------------------
  onProgress('search', `并行检索：${keys.map((k) => ANGLES[k].label).join(' · ')}`);
  const results = await llm.askParallel(keys, (k) => {
    onProgress('search:tick', `  · 检索「${ANGLES[k].label}」…`);
    return searchAngle(topic, k, model);
  }, 3);

  const ok = results.filter(Boolean);
  const failed = results.filter((r) => r && r.__error);
  if (failed.length) onProgress('search:warn', `  ⚠ ${failed.length} 个维度检索失败，继续聚合已有结果。`);
  const totalFindings = ok.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0);
  if (!totalFindings) {
    onProgress('search:warn', '  ⚠ 未检索到任何信息，将仅凭模型自身知识生成（内容可能较泛）。');
  } else {
    onProgress('search', `检索完成，共获得 ${totalFindings} 条原始信息点。`);
  }

  // ---- Phase B: aggregation → structured brief ----------------------------
  onProgress('aggregate', '汇总、去重并挑选最有价值的内容…');
  const material = ok.map((r) => ({
    angle: r.label,
    findings: (r.findings || []).map((f) => ({
      point: f.point || '',
      source: f.source || '',
      url: f.url || '',
    })),
  }));

  const brief = await llm.askJson({
    model: opts.aggModel || 'sonnet',
    maxTokens: 3000,
    system: 'You are a senior research editor. Synthesize raw research notes into a tight, ' +
            'high-signal research brief. Keep ONLY the most valuable, concrete, non-redundant ' +
            'points. Drop vague or duplicative items. Preserve real numbers and named entities. ' +
            'Write in Chinese unless the source material is English-only.',
    prompt:
      `主题：${topic}\n\n` +
      `以下是多维度联网检索得到的原始信息点（JSON）：\n${JSON.stringify(material, null, 2)}\n\n` +
      `请汇总成一份研究简报。要求：去重；按价值排序；保留所有具体数字、名称、来源。\n` +
      `输出 JSON：\n` +
      `{\n` +
      `  "topic": "主题",\n` +
      `  "summary": "2-3 句话总览（这个主题是什么、为什么重要、现状）",\n` +
      `  "themes": [{"title":"核心主题1","points":["信息点…"],"sources":[{"title":"","url":""}]}],\n` +
      `  "stats": [{"value":"数字（如 280亿美元）","label":"这是什么的数据","context":"一句话背景","source":"来源"}],\n` +
      `  "examples": [{"name":"案例/企业/产品名","desc":"它的亮点（一句话）","source":"来源"}],\n` +
      `  "trends": [{"title":"趋势名","desc":"具体描述","source":"来源"}],\n` +
      `  "challenges": ["挑战1","挑战2"],\n` +
      `  "sources": [{"title":"来源名","url":"链接"}]\n` +
      `}\n` +
      `每个数组保留最有价值的 3-8 条；stats 里的数字必须真实来自检索结果；找不到合适内容的字段返回空数组。`,
  });

  // Ensure shape + attach a deduped master source list (model's own + everything we saw).
  const allSources = mergeSources([
    Array.isArray(brief.sources) ? brief.sources : [],
    ...ok.map((r) => (r.findings || []).map((f) => ({ source: f.source, url: f.url }))),
  ]);
  brief.topic = brief.topic || topic;
  brief.sources = allSources;
  for (const k of ['themes', 'stats', 'examples', 'trends', 'challenges']) {
    if (!Array.isArray(brief[k])) brief[k] = [];
  }
  brief._meta = { depth, angles: keys, findings: totalFindings };

  onProgress('aggregate', `研究简报就绪：${brief.themes.length} 主题 / ${brief.stats.length} 数据 / ` +
                          `${brief.examples.length} 案例 / ${brief.trends.length} 趋势 / ${allSources.length} 来源。`);
  return brief;
}

// Pretty-print a brief for REPL / logs / saving alongside the deck.
function briefToString(b) {
  const lines = [];
  lines.push('═══ 研究简报 · ' + (b.topic || '') + ' ═══');
  if (b.summary) lines.push('\n▸ 总览\n' + b.summary);
  if (b.stats && b.stats.length) {
    lines.push('\n▸ 关键数据');
    b.stats.forEach((s) => lines.push(`  • ${s.value} — ${s.label}${s.source ? '  (' + s.source + ')' : ''}`));
  }
  if (b.themes && b.themes.length) {
    lines.push('\n▸ 核心主题');
    b.themes.forEach((t) => lines.push('  • ' + t.title + (t.points && t.points.length ? '\n      ' + t.points.join('；') : '')));
  }
  if (b.examples && b.examples.length) {
    lines.push('\n▸ 代表性案例');
    b.examples.forEach((e) => lines.push(`  • ${e.name}：${e.desc}`));
  }
  if (b.trends && b.trends.length) {
    lines.push('\n▸ 趋势');
    b.trends.forEach((t) => lines.push(`  • ${t.title}：${t.desc}`));
  }
  if (b.challenges && b.challenges.length) {
    lines.push('\n▸ 挑战\n  ' + b.challenges.map((c) => '• ' + c).join('\n  '));
  }
  if (b.sources && b.sources.length) {
    lines.push('\n▸ 来源 (' + b.sources.length + ')');
    b.sources.slice(0, 12).forEach((s) => lines.push('  • ' + (s.title || s.url)));
    if (b.sources.length > 12) lines.push('  • …（共 ' + b.sources.length + ' 条）');
  }
  return lines.join('\n');
}

module.exports = { research, briefToString, ANGLES, DEPTH };
