// lib/freeform-deck.js — compose a FULLY freeform deck from a research brief.
//
// This is the "格式由 LLM 决定" generator. Unlike lib/outline.js (which emits typed sections the
// 12 hardcoded renderers lay out), here the LLM authors every slide as placed elements, choosing
// a DIFFERENT composition archetype per slide so the deck never looks stamped from one template.
//
//   composeFreeformDeck(topic, brief, opts) -> { slides:[{t:'free',...}], meta }
//     1. plan  — allocate the brief into per-slide intents + assign varied archetypes (1 call)
//     2. compose — author each slide's elements from its intent + archetype (parallel, per slide)
// The orchestrator then runs build → layout-qa → review/revise until clean.

const llm = require('./llm');
const { TOOLBOX } = require('./freeform');

// Distinct composition archetypes — cycled so consecutive slides never share a layout.
// NOTE: no "big-number tile grid" archetype — that reads as obviously AI-generated. Numbers are
// woven into prose/bullets or shown as a chart/table instead.
const ARCHETYPES = [
  { key: 'hero-poster', hint: '海报式：超大标题区 + 一张主视觉图 + 极少要点，可用 ghost 背景大字增加气势，留白讲究但不空' },
  { key: 'magazine', hint: '杂志编辑式：一张大图占满一侧并出血，标题/正文跨过图片边缘叠放，有 tag 眉标与细分割线，讲究排版层次' },
  { key: 'sidebar-split', hint: '左右分栏：一侧文字/要点 + 另一侧配图或说明卡，比例可非对称（如 5:7）' },
  { key: 'numbered', hint: '编号叙事：用超大序号（ghost 或 badge）作视觉主轴，3 个步骤/要点纵向或横向排开，每条配小图' },
  { key: 'bento', hint: 'Bento 混排：3 个大小不一的内容块（标题块、要点块、配图块）拼满，每块是完整内容' },
  { key: 'bigquote', hint: '金句海报：一句超大引言居中/左对齐 + 出处 + 一张配图 + 2 条支撑要点，编辑感强' },
  { key: 'comparison', hint: '对比式：左右两栏对比（如 A vs B），中间分隔线，每栏各配一张图，结构对称' },
  { key: 'card-grid', hint: '卡片网格：2×2 或 3×2 等高卡片，每卡含配图+标题+完整描述（适合案例/列举）' },
  { key: 'asymmetric', hint: '非对称：一个主体大图/大块偏向一侧，其余要点与配图错落分布，有设计张力' },
];

const PALETTE_KEYS = 'dark / primary / mint / mintLt / coral / amber / violet / teal / ink / slate / muted / offWhite / cardTint / white';

function planPrompt(topic, brief, pages) {
  return `你在为「${topic}」规划一份内容丰满的 PPT，每页都将是 LLM 自由设计的版式（freeform）。
研究简报（含真实数据/案例/趋势/来源，JSON）：
${JSON.stringify({ summary: brief.summary, themes: brief.themes, stats: brief.stats, examples: brief.examples, trends: brief.trends, challenges: brief.challenges }, null, 1)}

请规划 ${pages} 张内容页（不含封面/结语），把简报里最有价值的内容分配到各页，每页聚焦一个主题。顺序建议：背景→应用/维度→案例→趋势→挑战（数据融入相关页的要点里，不要单独成页堆数字）。
输出严格 JSON：
{
  "coverTitle":"主标题","coverSub":"封面副标题","coverMeta":"封面小字","coverImg":"英文搜图词",
  "slides":[{"title":"页标题","subtitle?":"一句副标题","goal":"这页要表达什么","points":["信息点…"],"img?":"英文搜图词","cases?":[{"name":"名称","desc":"亮点"}]}],
  "closingTitle":"结语标题","closingSub?":"结语副标题"
}
要求：points 写成完整、具体、含数字或名称的句子（如『2025 年全球市场规模约 280 亿美元』）——**把数字写进句子里**，不要单独罗列数字；每页 3-6 个 points；案例放在专门的案例页。`;
}

function composePrompt(topic, slide, archetype, role) {
  const base =
    `主题：「${topic}」。可用调色板键：${PALETTE_KEYS}。\n` +
    `${TOOLBOX}\n\n`;
  if (role === 'cover') {
    return base +
      `请设计【封面页】——要极简，只突出主题，信息越少越好。\n` +
      `内容：大标题「${slide.coverTitle || topic}」，副标题「${slide.coverSub || ''}」，小字「${slide.coverMeta || ''}」。\n` +
      `要求：① 只放标题/副标题/小字，最多再加 1 个小图标徽章或一条窄配图，不要堆砌要点或数据；② 元素 ≤ 6 个；③ 背景用浅色调（offWhite / white / cardTint，或一张配图作窄边装饰），**不要全幅深色背景/深色遮罩**；④ 大量留白是好的、刻意追求；⑤ 标题用大字号(fit, min:40 max:60)。\n` +
      `输出严格 JSON：{"t":"free","bg":"offWhite","elements":[...]}。`;
  }
  if (role === 'closing') {
    return base +
      `请设计【结语页】——简洁、浅色调。内容：标题「${slide.closingTitle || topic + ' · 总结'}」${slide.closingSub ? '，副标题「' + slide.closingSub + '」' : ''}，并加上「谢谢观看 · Thank You」。\n` +
      `要求：浅色背景(bg:"offWhite" 或 cardTint)，深色文字；可加 1-2 个浅色装饰圆斑(oval, opacity 高)；不要深色背景。元素 ≤ 8。\n` +
      `输出严格 JSON：{"t":"free","bg":"offWhite","elements":[...]}。`;
  }
  return base +
    `请设计一张内容页，采用【${archetype.key}】构图：${archetype.hint}。\n` +
    `本页内容（JSON）：${JSON.stringify(slide)}\n\n` +
    `要求：\n` +
    `① 标题用字段：把本页标题放进 "title"，一句副标题放进 "sub"，"eyebrow" 放 2–6 字类别（如"02 · 应用"）。**不要把标题/副标题作为 elements 画进去**——系统会在顶部统一绘制标题带，保证全 deck 标题格式一致。\n` +
    `② 内容区为 y∈[2.1, 6.9]、x∈[0.6, 12.7]：所有 elements 只能落在该区域内，顶部 y<2.0 留给标题带，底部 y>7.0 留给页脚。\n` +
    `③ 用 fit/bullets 让文字填满盒子，**充分利用整个内容区，严禁出现横向/纵向的空带**（例如上半块和下半块之间留出一整条空白）。\n` +
    `④ 元素不得重叠、不得越出内容区与画布。文字颜色要与所在背景对比清晰。\n` +
    `⑤ 数字/案例必须用简报里的真实内容。${slide.cases && slide.cases.length ? '★本页含案例/示例，必须为每个案例配一张 image 元素（q 用与该案例相关的英文搜图词）。' : '若涉及具体产品/企业/案例，也必须配 image 元素。'}\n` +
    `⑥ 背景用浅色调（bg:"offWhite"），避免深色背景。\n` +
    `⑦ ★严禁"大数字 + 一句话"的独立方块（这是最明显的 AI 生成痕迹）：一页最多 1 个突出数字，且必须**融入完整的句子或要点**里（如『2025 年全球市场规模达 450 亿美元，十年增长超 10 倍』），不得把数字单独放大占一个框；绝不允许一页出现多个数字方块。要展示数值序列就用 chart 或 table，不要用大数字方格。\n` +
    `⑧ ★大块面（大卡片/大面板）**除列举/案例页外最多 3 个**——用少数几个大块承载内容，配以文字/图标/连接线点缀，**不要用很多小方块堆砌**。若是列举/案例页，用规整的 2×2 或 2×3 等大卡片网格。图片若放进方框，image 元素必须排在方框之后（数组靠后=上层），否则会被方框遮住。\n` +
    `⑨ ★**图文并茂是硬性要求**：每张内容页都必须有真实配图（image 元素，用英文搜图词）。多块并列页，**每个大块/每个案例都要配一张相关图片**——图片是版式主体而非可选装饰。只有实在没有合适照片时才用图标替代，且整页统一。\n` +
    `⑩ ★**并列的 2-3 个大块必须完全一致**：填色相同（都白底、或都浅底 cardTint、或都同一深色——不要一个白底一个深色/彩色底）、都配图或都用图标、标题/描述结构相同。ghost 背景大字只作淡淡的底层点缀，不能盖住或压过正文。\n` +
    `⑪ ★**每个大块内容要饱满**：描述写成 2-3 句完整具体的话或 3-5 条要点（用 fit/bullets），让文字撑满方框，**严禁框大字少、框内留白**。\n` +
    `★总元素 6–12 个，坐标/尺寸为合法小数（英寸）。\n` +
    `输出严格 JSON：{"t":"free","bg":"offWhite","eyebrow":"...","title":"...","sub":"...","note":"来源…","elements":[ ... ]}。`;
}

async function composeOne(topic, slide, archetype, role, model) {
  // covers are intentionally minimal/airy — don't impose the "fill the canvas" instruction on them.
  const sys = role === 'cover'
    ? 'You design a MINIMAL cover slide: just the title and theme, lots of whitespace, very few elements (≤6), light background. A cover highlights the topic and nothing else.'
    : 'You are an inventive presentation designer. You compose slides as absolutely-positioned '
      + 'elements on a 13.33"×7.5" canvas. You fill the canvas with a FEW large blocks (8-14 elements), '
      + 'never many small ones, never large empty areas, and prefer LIGHT backgrounds. Every deck slide uses a different composition.';
  const spec = await llm.askJson({
    model: model || 'sonnet', maxTokens: role === 'cover' ? 1400 : 2600, temperature: role === 'cover' ? 0.5 : 0.6,
    system: sys,
    prompt: composePrompt(topic, slide, archetype, role),
  });
  if (!spec || spec.t !== 'free' || !Array.isArray(spec.elements)) return null;
  if (role) spec.role = role; // 'cover' | 'closing' | 'content' — cover/closing exempt from whitespace QA
  if (archetype) spec._arch = archetype.key; // recorded so block-count QA can exempt real listing pages
  return spec;
}

/**
 * Compose a full freeform deck from a brief.
 * opts: { model, pages, onProgress }
 * Returns { slides, meta } where slides is a build-ready array (cover + content + closing).
 */
async function composeFreeformDeck(topic, brief, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  const pages = opts.pages || 8;
  const model = opts.model || 'sonnet';

  // 1) plan
  onProgress('plan', '规划内容页与版式…');
  const plan = await llm.askJson({
    model, maxTokens: 3000, temperature: 0.4,
    system: 'You plan a content-rich, well-structured presentation grounded in real research.',
    prompt: planPrompt(topic, brief, pages),
  });
  const planned = Array.isArray(plan.slides) ? plan.slides.slice(0, pages + 2) : [];
  onProgress('plan', `规划完成：${planned.length} 张内容页 + 封面 + 结语。`);

  // 2) compose each slide (parallel, cycling archetypes for variety); retry failed jobs once
  onProgress('compose', `并行设计 ${planned.length + 2} 张 freeform 幻灯片（每页不同构图）…`);
  const jobs = [];
  jobs.push({ role: 'cover', arch: ARCHETYPES[0], slide: plan });
  planned.forEach((s, i) => jobs.push({ role: 'content', arch: ARCHETYPES[(i + 1) % ARCHETYPES.length], slide: s }));
  jobs.push({ role: 'closing', arch: ARCHETYPES[1], slide: plan });

  const label = (job, i) => job.role === 'cover' ? '封面' : job.role === 'closing' ? '结语' : '第 ' + i + ' 页';
  const runJobs = async (list) => llm.askParallel(list, async (job) => {
    onProgress('compose:tick', `  · 设计 ${label(job, jobs.indexOf(job))}（${job.arch.key}）…`);
    try { return await composeOne(topic, job.slide, job.arch, job.role, model); }
    catch (e) { return { __error: e.message }; }
  }, 2);

  const results = (await runJobs(jobs)).slice();
  // retry pass for anything that didn't yield a valid free slide
  const failedIdx = results.map((r, i) => (r && r.t === 'free' ? -1 : i)).filter((i) => i >= 0);
  if (failedIdx.length) {
    onProgress('compose', `${failedIdx.length} 张失败，重试…`);
    const retry = await runJobs(failedIdx.map((i) => jobs[i]));
    retry.forEach((s, k) => { if (s && s.t === 'free') results[failedIdx[k]] = s; });
  }

  const slides = results.filter((s) => s && s.t === 'free');
  if (!slides.length) throw new Error('freeform composition produced no usable slides');
  onProgress('compose', `完成 ${slides.length} 张幻灯片。`);
  return { slides, meta: { archetypeCount: ARCHETYPES.length, planned: planned.length } };
}

module.exports = { composeFreeformDeck, ARCHETYPES };
