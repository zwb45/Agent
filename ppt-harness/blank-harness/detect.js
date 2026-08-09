// detect.js — the detection driver. Wires the Registry (T) + Context (C) + agent loop (llm.js)
// + geometry engine. Reads a .pptx's captured geometry as DATA (<deck>.layout.json / .spec.json
// produced by any builder, or python-pptx fallback) — does NOT import the PPT-generation harness.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const geo = require('./geometry');
const { Registry, registerBlankTools } = require('./tools');
const { Context } = require('./context');
const llm = require('./llm');

// Keys that are geometry/style metadata or chrome (not prose) — skipped when extracting a slide's
// text so the LLM judge sees the actual *words* (title/bullets/desc/...) and can reason about intent.
// Includes image-search query keys (q/query/search) so English search terms aren't read as content.
const TEXT_SKIP_KEYS = new Set(['x', 'y', 'w', 'h', 'd', 'cx', 'cy', 'r', 'color', 'fill', 'fontFace',
  'align', 'valign', 'k', 'id', 't', 'bg', 'role', '_arch', 'opacity', 'bold', 'italic', 'size',
  'fontSize', 'minSize', 'maxSize', 'paraSpaceAfter', 'charSpacing', 'layer', 'label', 'rotation',
  'rotate', 'seed', 'img', 'icon', 'src', 'points', 'q', 'query', 'search', 'note', 'footerLabel',
  'spec', 'url', 'href', 'ref', 'alt']);
// Element kinds that are decorative, not prose — their "text" would pollute the page content the LLM
// judges (e.g. a giant faint "AI" ghost glyph). Rendered decor text also carries _layer:'decor'.
const DECOR_KINDS = new Set(['ghost']);
// Recursively collect a slide's prose strings (typed fields + freeform element text), capped.
function slideText(sp) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { const s = v.trim(); if (s && s.length <= 200) out.push(s); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') {
      if (DECOR_KINDS.has(v.k) || v._layer === 'decor') return; // skip ghost/backdrop glyphs
      for (const key of Object.keys(v)) if (!TEXT_SKIP_KEYS.has(key)) walk(v[key]);
    }
  };
  walk(sp);
  return out.join(' / ').slice(0, 500);
}

function loadDeck(deckPptx) {
  const abs = path.resolve(deckPptx);
  let boxMap = null, specObj = null;
  const lf = abs + '.layout.json', sf = abs + '.spec.json';
  if (fs.existsSync(lf)) { try { boxMap = JSON.parse(fs.readFileSync(lf, 'utf8')).boxes || {}; } catch (e) {} }
  if (fs.existsSync(sf)) { try { specObj = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) {} }
  const specSlides = specObj && specObj.slides ? specObj.slides : null;
  if (!boxMap && !specSlides) { const e = extractPptx(abs); boxMap = e.boxes; specObj = { slides: e.slides }; }
  if (!boxMap) throw new Error('no <deck>.layout.json and could not read pptx geometry (need python-pptx, or build the deck through a harness that captures boxes).');
  const n = specSlides ? specSlides.length : Math.max(...Object.keys(boxMap).map(Number));
  const topic = (specObj && (specObj.deck || specObj.title)) || path.basename(abs, '.pptx');
  const slides = [];
  for (let i = 1; i <= n; i++) {
    const sp = specSlides ? specSlides[i - 1] : null;
    const role = (sp && sp.role) || (sp && sp.t === 'cover' ? 'cover' : sp && sp.t === 'closing' ? 'closing' : sp && sp.t === 'divider' ? 'divider' : 'content');
    slides.push({
      n: i, role, arch: (sp && sp._arch) || '',
      title: (sp && (sp.title || sp.eyebrow)) || '',
      text: sp ? slideText(sp) : '',
      boxes: (boxMap[i] || []).filter((b) => isFinite(b.x) && isFinite(b.w) && b.w > 0 && b.h > 0),
    });
  }
  // deck-level narrative context so the judge understands each page's role in the whole
  const context = { topic, pages: slides.map((s) => ({ n: s.n, role: s.role, arch: s.arch, title: String(s.title).slice(0, 30) })) };
  return { slides, deckPptx: abs, context };
}

function extractPptx(deckPptx) {
  const py = `
import json, sys
from pptx import Presentation
def inch(v): return round(v/914400.0,3) if v is not None else None
p=Presentation(sys.argv[1]); bb={}; ss=[]
for i,s in enumerate(p.slides,1):
  bs=[]
  for sh in s.shapes:
    try:
      x,y,w,h=inch(sh.left),inch(sh.top),inch(sh.width),inch(sh.height)
      if None in (x,y,w,h) or w<=0 or h<=0: continue
      cat='shape'
      if sh.shape_type==13: cat='image'
      elif getattr(sh,'has_chart',False): cat='chart'
      elif getattr(sh,'has_table',False): cat='table'
      elif sh.has_text_frame and sh.text_frame.text.strip(): cat='text'
      elif sh.has_text_frame: cat='chrome'
      bs.append({'layer':cat,'x':x,'y':y,'w':w,'h':h})
    except Exception: pass
  bb[str(i)]=bs; ss.append({'t':'content'})
print(json.dumps({'boxes':bb,'slides':ss}))
`;
  try { return JSON.parse(execFileSync('python', ['-c', py, deckPptx], { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONUTF8: '1' }) })); }
  catch (e) { return { boxes: null, slides: null }; }
}

const AGENT_SYS = `你是 PPT 版式质检专家，用一套"工具"检测幻灯片里的留白问题。关键：你要**结合每页的文字内容**判断留白是「真问题」还是「刻意设计」——而不是只看几何。

【工具】list_slides 看整体(含每页角色/构图/文字摘要)；read_page_text 读某页完整文字；measure_page 看元素概览；find_empty_regions 让系统精确测量空白矩形；find_thin_blocks 找"框大字少"；draw_red_box 给确认的留白画红框；finish 提交结论。

【核心原则：内容感知】留白本身不是错——错在「内容对所选版式明显过少」。所以判定前**必须先 read_page_text 读这页文字**，再结合几何判断，分三类：
- keep(不报)：内容明显是【引用/金句/极简强调/分隔/开篇 hook】——单句大字、居中短句、刻意追求留白。这是设计意图。
- thin(报 high/medium)：内容对版式明显过少——标题+1-2条短要点却用了多卡片/大块布局；大方框里只有一句话；两块内容之间夹着空带。
- uncertain(报 uncertain)：**实在分不清**是刻意极简还是内容不足——标 severity="uncertain" 并写明理由，交给人类确认，不要瞎猜。

【判定标准】
- 算问题(thin)：内容页占页面 ≥10% 的大块空白且文字不支持留白；框大字少。
- 不算问题(keep)：封面/结语/分隔页；引用/金句/极简页；页边距(约0.6")与卡片间距；标题带；小面积呼吸空间。

【重要】坐标永远来自工具测量(find_empty_regions/find_thin_blocks)，不要凭空估坐标。判定后用 draw_red_box 标出(severity 用 high/medium/uncertain，填 reason)，并在 finish 里汇总。
【流程】先 list_slides → 对每个内容页 find_empty_regions(有候选才继续) → **read_page_text 读文字** → 判定 keep/thin/uncertain → thin 用 draw_red_box(high/medium) 标出，uncertain 也用 draw_red_box(severity=uncertain)+理由标出，keep 不标 → finish 汇总全部确认项。`;

/**
 * Detect whitespace on a deck (agentic: tools + LLM). opts: { model, maxSteps, maxChars, onLog }
 */
async function detect(deckPptx, opts) {
  opts = opts || {};
  const onLog = opts.onLog || (() => {});
  const deck = loadDeck(deckPptx);
  const ctx = { drawn: {}, finished: null };
  const registry = new Registry();
  registerBlankTools(registry, deck, ctx);
  const context = new Context({ maxChars: opts.maxChars });

  onLog(`loaded ${deck.slides.length} slides; tools registered: ${registry.names().join(', ')}`);
  const ag = await llm.agent({
    model: opts.model || 'sonnet', maxSteps: opts.maxSteps || 24,
    system: AGENT_SYS,
    prompt: `检测这份 PPT 的留白问题：「${deck.context ? deck.context.topic : path.basename(deckPptx)}」。先用 list_slides 看整体；对有候选空白的内容页，**务必先 read_page_text 读文字**，再判定：内容过少→draw_red_box(high/medium)；引用/金句/极简等刻意留白→不报；拿不准→draw_red_box(severity=uncertain)+写明理由。最后 finish 汇总。`,
    registry, context,
    isDone: () => ctx.finished != null,
    onStep: (name, input) => onLog(`  → ${name}(${input && typeof input === 'object' && Object.keys(input).length ? JSON.stringify(input).slice(0, 60) : ''})`),
  });

  const src = (ctx.finished && Array.isArray(ctx.finished.blanks) && ctx.finished.blanks.length)
    ? ctx.finished.blanks
    : Object.entries(ctx.drawn).flatMap(([p, arr]) => arr.map((b) => Object.assign({ page: Number(p) }, b)));
  const byPage = {};
  for (const b of src) {
    byPage[b.page] = byPage[b.page] || [];
    byPage[b.page].push({ x: b.x, y: b.y, w: b.w, h: b.h, area: b.w * b.h, severity: b.severity || 'medium', reason: b.reason || '', kind: b.kind || 'blank' });
  }
  for (const pg of Object.keys(byPage)) byPage[pg] = geo.mergeOverlapping(byPage[pg]);
  const slides = deck.slides.map((s) => ({ n: s.n, role: s.role, blanks: byPage[s.n] || [] }));
  return { deckPptx: deck.deckPptx, slides, summary: (ctx.finished && ctx.finished.summary) || ag.text, steps: ag.steps, toolCalls: ag.toolCalls.length, repeatedCalls: ag.repeatedCalls, compactions: context.compactions };
}

function summarize(res) {
  const total = res.slides.reduce((n, s) => n + s.blanks.length, 0);
  return `${total} blank(s) on page(s): ${res.slides.filter((s) => s.blanks.length).map((s) => s.n).join(',') || 'none'}`;
}

// draw confirmed blanks as red boxes onto slide PNGs for human verification
async function visualize(res, opts) {
  opts = opts || {};
  let sharp; try { sharp = require('sharp'); } catch (e) { return { error: 'sharp not installed' }; }
  const dir = path.dirname(res.deckPptx), base = path.basename(res.deckPptx, '.pptx');
  const previewDir = opts.previewDir || path.join(dir, 'preview');
  const outDir = opts.outDir || path.join(dir, 'blankcheck');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
  const written = [];
  for (const s of res.slides) {
    if (!s.blanks.length) continue;
    const png = path.join(previewDir, `${base}-${String(s.n).padStart(2, '0')}.png`);
    if (!fs.existsSync(png)) continue;
    const img = sharp(png); const meta = await img.metadata();
    const sx = meta.width / geo.W, sy = meta.height / geo.H, parts = [];
    s.blanks.forEach((b, i) => {
      const x = b.x * sx, y = b.y * sy, w = b.w * sx, h = b.h * sy, sev = b.severity || 'medium';
      const stroke = sev === 'high' ? '#E0353B' : sev === 'medium' ? '#EF6F6C' : '#F2B05E';
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${stroke}" fill-opacity="0.16" stroke="${stroke}" stroke-width="3" stroke-dasharray="8 5"/>`);
      parts.push(`<text x="${(x + 6).toFixed(1)}" y="${(y + 20).toFixed(1)}" font-family="Microsoft YaHei,Arial" font-size="18" font-weight="bold" fill="${stroke}">${i + 1}/${sev}</text>`);
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${parts.join('')}</svg>`;
    const out = path.join(outDir, `${base}-blank-${String(s.n).padStart(2, '0')}.png`);
    await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
    written.push(out);
  }
  return { outDir, written };
}

module.exports = { detect, loadDeck, visualize, summarize, extractPptx };
