// lib/outline.js — turn (topic + research brief) into an outline JSON that the existing
// compiler lib/generate.js :: outlineToSlides already accepts.
//
// This is where "richness" lands in the deck: the LLM authors sections *grounded* in the
// brief — real stats from brief.stats, real cases in a table from brief.examples, real
// trends in a future page, sources carried into `note` fields. The compiler then fills
// icons / image queries / cover / agenda / closing / eyebrow numbers automatically.
//
// composeOutline(topic, brief, opts) -> outline object
//   opts: { model:'sonnet', pages:8-12, theme, style, lang }

const llm = require('./llm');

// Compact reference of the section kinds the compiler understands (mirrors
// prompts/generate-deck.md). Kept here so the synthesizer prompt is self-contained.
const KIND_REF = `可用页面类型 (kind) 与其字段（编译器会自动补封面/导览/结语/编号/图标/英文图搜词）：
- stats      : stats:[{big,label,sub?}], cols:[{title,bullets:[]}]            （关键数字 + 两栏要点）
- iconGrid   : items:[标题 或 {title,desc?,img?}]                              （3×2 卡片，每卡一图；≤6 项）
- quadrant   : items:[{title,desc?}]                                           （2×2 卡片；正好 4 项）
- future     : items:[{title,desc?}]                                           （3 张高卡趋势；正好 3 项）
- flow       : items:[{title,desc}]                                            （N 步流程；3-6 步）
- pipeline   : items:[{title,desc}]                                            （水平里程碑管线；3-6 阶段）
- twoCol     : left:{title,lead?,bullets:[]}, img?                             （左文卡 + 右图）
- table      : columns:[{header,key,w?,align?}], rows:[{key: 字符串|{text,color?,bold?}}] （数据表）
- chart      : cats:[], vals:[], chartTitle?, suffix?, max?, step?, color?, yTitle? （柱状图；数据必须真实）
- divider    : subtitle?, points?                                              （全幅图章节分隔，可选）`;

const DESIGN_REF = `视觉系统 design（你决定这份 PPT 长什么样；省略则编译器按主题自动挑）：
- theme: "healthcare"|"midnight"|"charcoal"|"berry" 之一，或用 palette 自定义 6 位 hex(不带#)
- header:"pill"|"bar"|"center"  cover:"photo"|"split"|"solid"  card:"shadow"|"flat"|"line"  decorate:"ovals"|"bars"|"dots"|"none"
- 或整包用 style:"classic"|"editorial"|"minimal"|"tech"|"bold"
按主题语气选：严肃/金融→midnight/charcoal；科技/AI→tech/冷色；创意/消费→暖色 editorial；极简/学术→minimal。`;

function buildPrompt(topic, brief, opts) {
  const target = opts.pages || '8 到 12';
  const themeHint = opts.theme ? `\n用户希望的主题倾向：${opts.theme}（可作为 theme 或 palette 起点）。` : '';
  const styleHint = opts.style ? `\n用户希望的版式倾向：${opts.style}。` : '';
  const briefJson = JSON.stringify({
    topic: brief.topic, summary: brief.summary,
    themes: brief.themes, stats: brief.stats, examples: brief.examples,
    trends: brief.trends, challenges: brief.challenges,
  }, null, 1);

  return `你在为「${topic}」设计一份内容丰满、信息密度高的 PPT。下面是一份基于联网检索的研究简报（含真实数字、案例、趋势与来源）。请**以这份简报为事实依据**来组织每一页内容——数字、案例、趋势必须来自简报，不得编造。

═══ 研究简报（JSON）═══
${briefJson}
═══ 简报结束 ═══

任务：产出一份 outline JSON，要求内容丰满、具体、有信息量（这是最高优先级）。${themeHint}${styleHint}

写作要求（务必遵守）：
1. 内容页共 ${target} 页，顺序建议：背景/概况 → 关键数据 → 核心应用/方向 → 深度详解 → 流程/路径 → 案例 → 趋势/展望。封面/结语不用写（编译器自动补）。
2. **stats 页**：用简报里的真实数字（brief.stats），big 放数字、label 放含义、sub 放背景；note 标来源。
3. **table 页**：把代表性案例（brief.examples）做成表格，列如 名称/领域/核心能力/状态；至少 3 行真实案例。
4. **future 页**：用简报的真实趋势（brief.trends），正好 3 项。
5. **挑战**：如有 brief.challenges，用 twoCol 或 iconGrid 呈现。
6. 每个内容页尽量带 sub（标题下一句副标题）提升信息量；desc 要写成完整、具体、含数字或名称的句子（不要空话）。
7. **chart 页**：仅当简报里有真实可比较的数值序列（如多年增长、各玩家份额）时才用，cats/vals 必须真实；没有合适数据就**不要**编造图表。
8. 别写设计元信息（"这一页配图""图文并茂"会被拦截）。
9. img 用英文搜索词更准（可省略，编译器会按关键词补）。

${KIND_REF}

${DESIGN_REF}

输出严格 JSON，结构如下（只输出 JSON，不要任何解释或代码围栏）：
{
  "topic": "主标题",
  "subtitle": "封面副标题",
  "meta": "封面小字，如 2026 · 行业洞察",
  "footerLabel": "页脚文字",
  "theme": "healthcare|midnight|charcoal|berry 或省略",
  "design": { "style": "..." 或省略, "header":"...", "cover":"...", "card":"...", "decorate":"..." },
  "sections": [ { "kind": "...", "title": "...", "sub": "...", "note": "来源…", ...该 kind 的字段 } ]
}`;
}

/**
 * Author an outline grounded in the research brief.
 * opts: { model, pages, theme, style }
 */
async function composeOutline(topic, brief, opts) {
  opts = opts || {};
  const outline = await llm.askJson({
    model: opts.model || 'sonnet',
    maxTokens: 4500,
    temperature: 0.5,
    system: 'You are an expert presentation designer who writes information-dense, ' +
            'well-structured decks. You always ground content in the provided research ' +
            '(real numbers, named examples, cited sources) and never fabricate data.',
    prompt: buildPrompt(topic, brief, opts),
  });

  // Light normalization so a slightly-off model output still compiles cleanly.
  outline.topic = outline.topic || brief.topic || topic;
  if (!Array.isArray(outline.sections)) outline.sections = [];
  outline.sections = outline.sections
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const c = Object.assign({}, s);
      if (!c.kind) c.kind = 'iconGrid';
      if (c.kind === 'closing' || c.kind === 'cover' || c.kind === 'agenda') return null; // auto-generated
      return c;
    })
    .filter(Boolean);

  // If the model emitted a palette under design but no theme, keep design as-is; the CLI
  // resolves palette/theme/style from the outline object.
  return outline;
}

module.exports = { composeOutline, KIND_REF, DESIGN_REF };
