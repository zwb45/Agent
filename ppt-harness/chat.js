#!/usr/bin/env node
// chat.js — the interactive interface. Launch it, then make requests in natural language:
//
//     node chat.js
//     ppt> 请帮我生成一个量子计算入门的 ppt
//     ppt> 换成深色主题
//     ppt> 再加一页关于商业化落地的内容
//     ppt> 去掉配图重新出
//     ppt> /quit
//
// Or run a one-shot then stay in the session:
//     node chat.js "生成一个新能源车行业的 ppt，深色，详细一点"
//
// Behind the scenes every "generate" runs: web research (gather+aggregate) → grounded
// outline → compile → validate → build .pptx + previews. See lib/orchestrator.js.

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const llm = require('./lib/llm');
const { generateDeck, generateFreeformDeck, buildFromOutline, buildWithReview } = require('./lib/orchestrator');
const { outlineToSlides } = require('./lib/generate');
const { briefToString } = require('./lib/research');
const { KIND_REF } = require('./lib/outline');
const { TOOLBOX, ARCHETYPES } = require('./lib/freeform');

const BANNER = `
╔══════════════════════════════════════════════════════════════╗
║   ppt-harness · 研究驱动的 PPT 生成助手                        ║
║   直接用自然语言提需求，例如：                                  ║
║     • 请帮我生成一个「量子计算入门」的 ppt                      ║
║     • 做一份新能源车行业的演示，深色、详细一点                   ║
║     • generate a deck on CRISPR gene editing                   ║
║   后续可追加：换主题/加一页/去配图/重新生成。输入 /help 查看全部 ║
╚══════════════════════════════════════════════════════════════╝
`.trim();

const HELP = `
命令：
  <任意主题/需求>     生成一份新的 PPT（先联网研究，再撰写大纲，最后渲染）
  创意/自由版式        让 LLM 自由设计每页版式（最大多样性，自动校验重叠/留白）
  深色 / 极简 / 科技   在当前 deck 上换主题或版式（无需重新研究，秒级重渲染）
  加一页关于 X         给当前 deck 追加一页讲 X 的内容，然后重渲染
  去掉配图 / 加配图     切换在线配图（默认开启），重渲染
  重新生成 / 再来一次   用同一主题重新研究并生成
  /research <主题>    只做联网研究，打印研究简报（不生成 PPT）
  /outline            打印当前 deck 的大纲 / 幻灯片 JSON
  /brief              打印当前 deck 的研究简报
  /help               显示本帮助
  /quit               退出

可选修饰词（写在需求里即可）：深色/暗色 · 极简 · 科技感 · 暖色 · 严肃商务
                              详细/丰富（多页）· 简短/精简（少页）· 不配图/离线 · 创意/自由版式
可选参数：--theme <名> --style <名> --pages <N> --depth quick|standard|deep --no-images --freeform
`.trim();

// ---- request parsing -------------------------------------------------------

// Pull out --flag value / --flag tokens, return {opts, text}.
function stripFlags(input) {
  const opts = {};
  const flagRe = /--([a-zA-Z-]+)(?:(=|\s+)(\S+))?/g;
  const text = input.replace(flagRe, (m, k, sep, v) => {
    if (['no-images', 'no-images'.replace('-', '')].includes(k) || k === 'noimages') { opts.noImages = true; return ' '; }
    if (v == null) { opts[k] = true; return ' '; }
    if (['theme', 'style', 'depth'].includes(k)) opts[k] = v;
    else if (k === 'pages') opts.pages = parseInt(v, 10);
    else opts[k] = v;
    return ' ';
  });
  return { opts, text: text.replace(/\s+/g, ' ').trim() };
}

const THEME_HINTS = [
  ['midnight', ['深色', '暗色', '黑色', '深蓝', '海军']],
  ['charcoal', ['炭灰', '高级灰', '灰色调', '商务', '严肃', '正式']],
  ['berry', ['莓果', '暖色', '活泼', '品牌', '创意', '消费']],
];
const STYLE_HINTS = [
  ['minimal', ['极简', '简约', '留白', '学术', '简洁']],
  ['tech', ['科技感', '未来感', '科技', '技术风', '酷']],
  ['editorial', ['杂志', '编辑感', '质感']],
  ['bold', ['大胆', '醒目', '冲击力', '强烈']],
];

function detectHints(text) {
  const out = {};
  for (const [v, keys] of THEME_HINTS) if (keys.some((k) => text.includes(k))) { out.theme = v; break; }
  for (const [v, keys] of STYLE_HINTS) if (keys.some((k) => text.includes(k))) { out.style = v; break; }
  if (/详细|丰富|深入|多页|全面|完整/.test(text)) out.pages = 12;
  else if (/简短|精简|少|快速|简洁|概览/.test(text)) out.pages = 6;
  // image toggle: check the negative case first, and make the positive case specific enough
  // that "不配图" (which contains "配图") does NOT match the positive pattern.
  if (/不配图|无图|不要图|不要配图|纯文字|离线|关掉配图/.test(text)) out.useImages = false;
  else if (/加配图|要配图|打开配图|带配图|需要配图|配上图|加图/.test(text)) out.useImages = true;
  if (/快速|速览|quick/.test(text)) out.depth = 'quick';
  else if (/深度|深入|详尽|deep|彻底/.test(text)) out.depth = 'deep';
  // freeform / creative mode: the LLM designs every slide's layout (max visual variety)
  if (/自由版式|自由|创意|多样|不一样|新颖|freeform|creative|unique/.test(text)) out.freeform = true;
  return out;
}

const STOP = ['请', '帮我', '帮', '我', '想要', '想', '生成', '制作', '创建', '做', '做个', '弄', '来',
  '一个', '一份', '一点', '一些', '比较', '稍微', '的话', '关于', '有关', '讲', '介绍',
  '主题', '话题', '版式', '风格', '风', '感', '样子', '的', '了', '吧', '哈', '哦', '？', '?',
  '创意', '自由版式', '自由', '多样', '新颖', '不一样',
  'ppt', 'pptx', '演示', '演示文稿', '幻灯片', '汇报', '课件', 'deck', 'presentation', 'slides', 'freeform',
  'make', 'create', 'generate', 'a', 'an', 'about', 'on', 'the', 'of', 'for', 'me', 'please'];

function extractTopic(text) {
  let t = text;
  // strip detected hint words so they don't leak into the topic
  for (const keys of [...THEME_HINTS, ...STYLE_HINTS]) for (const k of keys[1]) t = t.split(k).join(' ');
  t = t.replace(/(详细|丰富|深入|多页|全面|完整|简短|精简|概览|不配图|无图|不要图|不要配图|离线|纯文字|加配图|带配图|配图|带图|要图|加图|快速|速览|深度|详尽|深色|暗色|炭灰|暖色|商务|严肃|极简|简约|科技|杂志|大胆|创意|自由版式|自由|多样|新颖|不一样|版式|freeform)/g, ' ');
  // remove whole-word stopwords (CN char-by-char is awkward; do substring replace for CN, word-boundary for EN)
  for (const w of STOP) {
    if (/^[a-z]+$/i.test(w)) t = t.replace(new RegExp('\\b' + w + '\\b', 'gi'), ' ');
    else t = t.split(w).join(' ');
  }
  t = t.replace(/[，,。:：、·“”"''()（）\s]+/g, ' ').trim();
  return t;
}

function parseRequest(raw) {
  const { opts: flags, text } = stripFlags(raw);
  const hints = detectHints(text);
  const merged = { ...hints, ...flags }; // explicit flags win
  const topic = extractTopic(text);
  return { topic, opts: merged, text };
}

// ---- follow-up intent detection -------------------------------------------

function isRetheme(text) {
  return /换成|改为|改用|换一个主题|换个主题|换风格|改风格/.test(text)
    || /^(深色|暗色|极简|科技|暖色|严肃|商务)\s*[。.!]?$/.test(text)
    || /(\S+)\s*(主题|风格|版式)/.test(text) && /(换|改|用)/.test(text);
}
function isToggleImages(text) { return /去掉配图|不要配图|无图|不配图|关掉配图|离线/.test(text) || /加配图|要配图|打开配图|带图|要图/.test(text); }
function isAddPage(text) { return /加一页|新增一页|增加一页|插入一页|再加一?页|补一页|加一个.*页/.test(text); }
function isRegenerate(text) { return /^(重新生成|重新做|再来一次|重做|重新|重新研究|再生成)\b/.test(text); }

// ---- one-section composer for "add a page" --------------------------------

async function composeOneSection(topic, hint, model) {
  const j = await llm.askJson({
    model: model || 'sonnet', maxTokens: 700, temperature: 0.4,
    system: 'You add ONE information-rich slide to an existing deck about a topic. ' +
            'Output one section object only.',
    prompt: `现有 PPT 主题：「${topic}」。请新增一页关于「${hint}」的内容，要求具体、有信息量（可联网检索事实）。\n\n${KIND_REF}\n\n` +
            `输出严格 JSON：一个 section 对象，如 {"kind":"iconGrid","title":"...","sub":"...","items":[...]}` +
            `（只需这一个对象，不要数组、不要解释）。desc 要写成完整具体的句子。`,
  });
  return j;
}

// Compose ONE freeform slide about `hint` for an existing freeform deck (used by "加一页").
async function composeOneFree(topic, hint, model) {
  const arch = ARCHETYPES[Math.floor((hint.length || 1) % ARCHETYPES.length)];
  const j = await llm.askJson({
    model: model || 'sonnet', maxTokens: 2500, temperature: 0.7,
    system: 'You compose ONE freeform presentation slide as placed elements on a 13.33"×7.5" canvas, ' +
            'filling it with high information density and no large empty areas.',
    prompt: `主题：「${topic}」。请设计一张关于「${hint}」的 freeform 内容页，采用【${arch.key}】构图（${arch.hint}）。\n` +
            `${TOOLBOX}\n\n输出严格 JSON：{"t":"free","bg":"offWhite","elements":[...]}。内容要具体（可联网检索事实）。`,
  });
  return j;
}

// ---- the app ---------------------------------------------------------------

class App {
  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'ppt> ' });
    this.state = { topic: null, outline: null, brief: null, file: null, baseOpts: {} };
    this.busy = false;
    this.interactive = false; // true only when started via start() (REPL); --once stays non-interactive
    this._pendingResolve = null; // set by ask() to grab the next input line as an answer
  }

  log(s) { process.stdout.write((s == null ? '' : String(s)) + '\n'); }

  // Ask the user a question mid-generation and await the answer (used by onUncertain). The next
  // input line resolves the promise (intercepted at the top of the 'line' handler, before busy).
  ask(q) {
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      this.log('\n❓ ' + q);
      this.rl.setPrompt('回复（回车=保留，n=补充）> ');
      this.rl.prompt();
    });
  }

  async ensureLLM() {
    if (this._llmOk != null) return this._llmOk;
    this.log('正在连接 LLM 服务…');
    try { this._llmOk = await llm.ping(); }
    catch (e) { this._llmOk = false; this._llmErr = e.message; }
    if (!this._llmOk) {
      this.log('⚠ 无法连接 LLM（' + (this._llmErr || '未知错误') + '）。');
      this.log('  请确认环境变量已设置：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN。');
    }
    return this._llmOk;
  }

  progress(stage, detail) {
    // compact live status; group by stage prefix
    if (detail) this.log('  ' + detail);
  }

  async handleLine(line) {
    const raw = (line || '').trim();
    if (!raw) return;

    // slash commands
    if (raw[0] === '/') {
      const [cmd, ...rest] = raw.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      switch (cmd.toLowerCase()) {
        case 'quit': case 'exit': this.log('再见！'); this.rl.close(); process.exit(0);
        case 'help': this.log(HELP); return;
        case 'outline': case 'slides':
          if (!this.state.mode) return this.log('（还没有 deck。先让我生成一份吧。）');
          return this.log(JSON.stringify(this.state.mode === 'freeform' ? this.state.slides : this.state.outline, null, 2));
        case 'brief':
          if (!this.state.brief) return this.log('（还没有研究简报。）');
          return this.log(briefToString(this.state.brief));
        case 'research': return this.doResearchOnly(arg || this.state.topic);
        default: return this.log('未知命令：/' + cmd + '。输入 /help 查看可用命令。');
      }
    }

    if (!(await this.ensureLLM())) return;

    // follow-ups that operate on the current deck
    if (this.state.mode) {
      if (isRegenerate(raw)) return this.generate(this.state.topic, { ...this.state.baseOpts, fresh: true });
      if (isToggleImages(raw)) {
        const next = /去掉|不要|无图|不配图|关掉|离线/.test(raw) ? false : true;
        return this.rebuild({ useImages: next });
      }
      if (isRetheme(raw)) return this.retheme(raw);
      if (isAddPage(raw)) return this.addPage(raw);
    }

    // default: a new generation request
    const { topic, opts } = parseRequest(raw);
    if (!topic) return this.log('没看懂主题。试试：请帮我生成一个「量子计算入门」的 ppt（输入 /help 查看更多）');
    return this.generate(topic, opts);
  }

  async doResearchOnly(topic) {
    if (!topic) return this.log('用法：/research <主题>');
    this.busy = true;
    try {
      const { research } = require('./lib/research');
      const brief = await research(topic, { depth: 'standard', onProgress: (p, d) => this.progress(p, d) });
      this.state.brief = brief; this.state.topic = topic;
      this.log('\n' + briefToString(brief));
    } catch (e) { this.log('研究失败：' + e.message); }
    finally { this.busy = false; }
  }

  async generate(topic, opts) {
    this.busy = true;
    const t0 = Date.now();
    try {
      this.log(`\n🎯 主题：「${topic}」` + (Object.keys(opts).length ? '  选项：' + JSON.stringify(opts) : ''));
      const common = {
        depth: opts.depth || 'standard',
        pages: opts.pages,
        useImages: opts.noImages ? false : (opts.useImages !== false),
        cwd: process.cwd(),
        onProgress: (p, d) => this.progress(p, d),
        onWarn: (d) => this.log('  ⚠ ' + d),
        // When the blank-check can't tell intentional whitespace from under-filled, ask the user
        // (only in the interactive REPL; --once/programmatic omit this → orchestrator keeps+warns).
        onUncertain: this.interactive ? async (items) => {
          const decisions = [];
          for (const it of items) {
            const ans = (await this.ask(it.msg)).trim().toLowerCase();
            const fix = ans === 'n' || ans.startsWith('不') || ans.startsWith('补') || ans === 'no' || ans === 'fix';
            decisions.push(Object.assign({}, it, { keep: !fix }));
            this.log(fix ? '  → 将补充该处留白' : '  → 保留该处留白');
          }
          this.rl.setPrompt('ppt> ');
          return decisions;
        } : undefined,
      };
      let res, mode;
      if (opts.freeform) {
        mode = 'freeform';
        this.log('   🎨 自由版式模式：每页版式由 LLM 独立设计（最大多样性）…');
        res = await generateFreeformDeck(topic, { ...common, theme: opts.theme, style: opts.style, maxIters: 3 });
      } else {
        mode = 'typed';
        res = await generateDeck(topic, {
          ...common, theme: opts.theme, style: opts.style,
          themeHint: opts.theme, styleHint: opts.style,
        });
      }
      const nContent = mode === 'freeform' ? res.slides.filter((s) => s.t === 'free').length : res.outline.sections.length;
      this.state = {
        mode, topic, outline: res.outline || null, slides: res.slides || null,
        brief: res.brief, file: res.file, baseOpts: opts, theme: opts.theme, style: opts.style,
      };
      this.log(`\n✅ 完成（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      this.log('   ' + (mode === 'freeform' ? '自由版式 ' : '') + '共 ' + (res.slides ? res.slides.length : res.outline.sections.length) + ' 张幻灯片');
      this.log('   📄 ' + res.file);
      this.log('   接着可以说：换成深色主题 · 加一页关于 X · 去掉配图 · 重新生成' + (mode === 'typed' ? '' : ''));
    } catch (e) {
      this.log('\n❌ 生成失败：' + e.message);
    } finally { this.busy = false; }
  }

  // cheap rebuild from the current deck (no research); handles typed (outline) + freeform (slides)
  async rebuild(overrides) {
    if (!this.state.mode) return this.log('（还没有 deck。）');
    this.busy = true; const t0 = Date.now();
    try {
      const useImages = overrides.useImages != null ? overrides.useImages : (this.state.baseOpts.noImages ? false : true);
      this.log(useImages ? '\n🖼  重新渲染（带配图）…' : '\n🔳 重新渲染（离线 · 无配图）…');
      let res;
      if (this.state.mode === 'freeform') {
        res = await buildWithReview(this.state.slides, {
          useImages, renderPreview: false, maxIters: 0,
          theme: this.state.theme, style: this.state.style, title: this.state.topic,
          out: this.state.file, cwd: process.cwd(),
          onProgress: (p, d) => this.progress(p, d), onWarn: (d) => this.log('  ⚠ ' + d),
        });
      } else {
        res = await buildFromOutline(this.state.outline, {
          useImages, theme: this.state.theme, style: this.state.style, cwd: process.cwd(),
          out: this.state.file,
          onProgress: (p, d) => this.progress(p, d), onWarn: (d) => this.log('  ⚠ ' + d),
        });
      }
      this.state.file = res.file; this.state.slides = res.slides || this.state.slides;
      this.state.baseOpts.noImages = !useImages;
      this.log(`\n✅ 重渲染完成（${((Date.now() - t0) / 1000).toFixed(1)}s）→ ${res.file}`);
    } catch (e) { this.log('❌ 重渲染失败：' + e.message); }
    finally { this.busy = false; }
  }

  async retheme(raw) {
    if (!this.state.mode) return this.log('（还没有 deck。）');
    const hints = detectHints(raw);
    let changed = [];
    if (hints.theme) { this.state.theme = hints.theme; changed.push('theme=' + hints.theme); }
    if (hints.style) { this.state.style = hints.style; changed.push('style=' + hints.style); }
    if (this.state.mode === 'typed' && this.state.outline) {
      const design = this.state.outline.design || (this.state.outline.design = {});
      if (hints.theme) { this.state.outline.theme = hints.theme; design.style = undefined; }
      if (hints.style) design.style = hints.style;
    }
    if (!changed.length) return this.log('没识别出主题/版式关键词。试试：换成深色 / 用极简风格。');
    this.log('调整版式：' + changed.join('，') + '，重新渲染…');
    return this.rebuild({});
  }

  async addPage(raw) {
    if (!this.state.mode) return this.log('（还没有 deck。）');
    let hint = raw.replace(/.*(加一页|新增一页|增加一页|插入一页|再加一?页|补一页|加一个.*?页)/, '').replace(/关于|讲|介绍|的内容|内容|的/g, '').trim();
    if (!hint) hint = this.state.topic;
    this.busy = true;
    try {
      this.log('为「' + this.state.topic + '」新增一页：' + hint + ' …');
      if (this.state.mode === 'freeform') {
        const slide = await composeOneFree(this.state.topic, hint);
        if (!slide || slide.t !== 'free') return this.log('⚠ 未能生成新页面。');
        this.state.slides.push(slide);
        this.log('已加入新的 freeform 页，重新渲染…');
      } else {
        const sec = await composeOneSection(this.state.topic, hint);
        if (!sec || !sec.kind) return this.log('⚠ 未能生成新页面。');
        this.state.outline.sections.push(sec);
        this.log('已加入新页（' + sec.kind + '），重新渲染…');
      }
      return this.rebuild({});
    } catch (e) { this.log('❌ 新增页面失败：' + e.message); }
    finally { this.busy = false; }
  }

  start(initial) {
    this.interactive = true;
    this.log(BANNER);
    this.rl.prompt();
    this.rl.on('line', async (line) => {
      if (this._pendingResolve) { const r = this._pendingResolve; this._pendingResolve = null; r(line); return; }
      if (this.busy) { this.log('（正在处理上一个请求，请稍候…）'); return; }
      try { await this.handleLine(line); }
      catch (e) { this.log('⚠ ' + e.message); }
      if (!this.busy) this.rl.prompt();
    });
    this.rl.on('close', () => { process.exit(0); });
    if (initial) {
      // run the initial one-shot, then continue interactively
      setImmediate(() => this.handleLine(initial).then(() => this.rl.prompt()));
    }
  }
}

// entrypoint (only when run directly, not when required for testing)
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(0); }
  const once = argv.includes('--once'); // generate the given request then exit (scripting)
  const initial = argv.filter((a) => !a.startsWith('-')).join(' ').trim();
  const app = new App();
  if (once && initial) {
    app.ensureLLM().then((ok) => {
      if (!ok) process.exit(1);
      return app.handleLine(initial).then(() => process.exit(0));
    });
  } else {
    app.start(initial);
  }
}

module.exports = { App, parseRequest, extractTopic, detectHints, stripFlags,
  isRetheme, isToggleImages, isAddPage, isRegenerate, HELP, BANNER };
