// beautify.js — re-layout an existing deck so it reads as designed by a human.
//
// Two entry points:
//   beautifySpec(spec, opts)   — improve a slides spec (works on any harness deck's .spec.json).
//                                Re-types slides to the layout that fits the content's shape,
//                                snaps card counts to "magic" grid numbers (3/4/6), trims
//                                over-long text, drops thin/empty slides, restores structure.
//   importPptx(pptx, opts)     — extract a rough spec from ANY .pptx (python-pptx), so an ugly
//                                external deck can be re-flowed through our polished layouts.
//
// Aesthetic taste here is encoded as deterministic heuristics (no vision model). Every change is
// logged so the "rearrange / prune" decisions are transparent. Render before/after PNGs to judge.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const gen = require('./generate');   // pickIcon, imgQuery, assignIds, CONTENT_KINDS, KIND_LABEL

const KEEP_TYPE = new Set(['cover', 'divider', 'agenda', 'closing']);
const DATA_TYPE = new Set(['chart', 'table', 'stats']); // carry structured data → don't re-type

// ----------------------------- text helpers -----------------------------

// Display weight: CJK/fullwidth char = 1, everything else = 0.5. Used for length thresholds.
function weight(s) {
  let n = 0;
  for (const ch of String(s || '')) n += /[　-鿿＀-￯‐-⁯]/.test(ch) ? 1 : 0.5;
  return n;
}

// Truncate to a display-weight budget, preferring a punctuation boundary; append … if cut.
function trunc(s, max) {
  if (s == null) return s;
  s = String(s).replace(/\s+/g, ' ').trim();
  if (weight(s) <= max) return s;
  let cut = '';
  let w = 0;
  for (const ch of s) {
    cut += ch; w += weight(ch);
    if (w >= max) break;
  }
  const m = cut.match(/.*[，。；,.;!！?？、·:：]/);
  if (m && weight(m[0]) > max * 0.5) cut = m[0];
  return cut.replace(/[，。；,.;!！?？、·:：\s]+$/, '') + '…';
}

// ----------------------------- content extraction -----------------------------

function normItem(c) {
  if (c == null) return null;
  if (typeof c === 'string') return { title: c, desc: '' };
  return { title: c.title || '', desc: c.desc || '', icon: c.icon, img: c.img, color: c.color };
}

// Pull a slide's content into a neutral shape, independent of its current type.
function extractContent(s) {
  const items = [], bullets = [], stats = [];
  for (const k of ['cards', 'items', 'steps', 'phases']) {
    if (Array.isArray(s[k])) for (const c of s[k]) { const it = normItem(c); if (it && (it.title || it.desc)) items.push(it); }
  }
  const pushBullets = (arr) => { if (Array.isArray(arr)) for (const b of arr) if (b && String(b).trim()) bullets.push(String(b).trim()); };
  pushBullets(s.points); pushBullets(s.bullets);
  if (s.left && s.left.title && !s.title) s.title = s.left.title;
  if (s.left) pushBullets(s.left.bullets);
  if (Array.isArray(s.cols)) for (const c of s.cols) pushBullets(c.bullets);
  if (Array.isArray(s.stats)) for (const st of s.stats) if (st && (st.big || st.label)) stats.push(st);
  return {
    title: s.title || '', sub: s.sub || '', lead: s.lead || '', note: s.note || '',
    eyebrow: s.eyebrow, img: s.img, items, bullets, stats,
    chart: s.chart || null, table: (s.columns ? { columns: s.columns, rows: s.rows } : null),
  };
}

function isSequential(text) {
  return /步骤|阶段|流程|首先|然后|接着|最后|第[一二三四五六七八九十百\d]+\s*[步阶段]|phase|step|stage|pipeline|流程图|管线/i.test(text || '');
}
function isPhaseLike(text) {
  return /阶段|phase|milestone|管线|pipeline|节点|里程碑/i.test(text || '');
}

// bullets → card items (split "标题：描述" if a short clause precedes a colon)
function bulletsToItems(bullets) {
  return (bullets || []).map((b) => {
    const s = String(b);
    const m = s.split(/[:：]/);
    if (m.length >= 2 && m[0].length <= 16 && m[0].length > 0) return { title: m[0].trim(), desc: m.slice(1).join(':').trim() };
    return { title: s, desc: '' };
  });
}

// ----------------------------- the passes -----------------------------

const LIMITS = { slideTitle: 28, sub: 48, lead: 80, cardTitle: 16, cardDesc: 70, bullet: 42, statBig: 12, statLabel: 16 };

function pruneText(s, L) {
  if (s.title) s.title = trunc(s.title, LIMITS.slideTitle);
  if (s.sub) s.sub = trunc(s.sub, LIMITS.sub);
  if (s.lead) s.lead = trunc(s.lead, LIMITS.lead);
  for (const k of ['cards', 'items', 'steps', 'phases']) {
    if (!Array.isArray(s[k])) continue;
    for (const c of s[k]) {
      if (c && typeof c === 'object') {
        if (c.title) c.title = trunc(c.title, LIMITS.cardTitle);
        if (c.desc) c.desc = trunc(c.desc, LIMITS.cardDesc);
      }
    }
  }
  const trimList = (arr) => { if (Array.isArray(arr)) for (let i = 0; i < arr.length; i++) arr[i] = trunc(arr[i], LIMITS.bullet); };
  trimList(s.bullets); trimList(s.points);
  if (s.left && s.left.bullets) trimList(s.left.bullets);
  if (Array.isArray(s.cols)) for (const c of s.cols) trimList(c.bullets);
  if (Array.isArray(s.stats)) for (const st of s.stats) { if (st.big) st.big = trunc(st.big, LIMITS.statBig); if (st.label) st.label = trunc(st.label, LIMITS.statLabel); }
}

// Snap card/item counts to clean grid numbers per type.
function balanceCounts(s, L) {
  const cap = (key, max, label) => {
    if (Array.isArray(s[key]) && s[key].length > max) {
      const dropped = s[key].length - max;
      s[key] = s[key].slice(0, max);
      L(`trim ${s.t}.${key} ${max + dropped}→${max} (${label})`);
    }
  };
  if (s.t === 'iconGrid') cap('cards', 6, '3×2 grid');
  else if (s.t === 'quadrant') cap('cards', 4, '2×2 grid');
  else if (s.t === 'future') cap('cards', 3, '3-column');
  else if (s.t === 'flow') cap('steps', 6, 'step row');
  else if (s.t === 'pipeline') cap('phases', 6, 'milestone row');
  else if (s.t === 'stats') cap('stats', 4, 'stat row');
  const capList = (arr, max, label) => { if (Array.isArray(arr) && arr.length > max) { L(`trim ${label} ${arr.length}→${max}`); arr.length = max; } };
  if (Array.isArray(s.cols)) for (const c of s.cols) capList(c.bullets, 6, 'bullets');
  if (s.left && s.left.bullets) capList(s.left.bullets, 6, 'bullets');
}

// Decide the best-fitting layout type for a content slide's extracted content.
function decideType(c) {
  if (c.stats && c.stats.length) return 'stats';
  let items = c.items.slice();
  if (!items.length && c.bullets.length) items = bulletsToItems(c.bullets);
  const n = items.length;
  const allText = c.title + ' ' + c.sub + ' ' + items.map((i) => i.title + ' ' + i.desc).join(' ');
  if (n <= 1) return null;                       // too thin → drop candidate
  if (isSequential(allText) && n >= 3 && n <= 6) return isPhaseLike(allText) ? 'pipeline' : 'flow';
  if (n >= 7) return 'iconGrid';                 // → trim to 6
  if (n === 6) return 'iconGrid';                // 3×2
  if (n === 5) return 'quadrant';                // → trim to 4 (cleaner than 3+2)
  if (n === 4) return 'quadrant';                // 2×2
  if (n === 3) return 'iconGrid';                // 1×3
  if (n === 2) return null;                       // keep (avoid gappy 2-card grids)
  return null;
}

function withCardImgs(items, topicImg) {
  return items.map((i) => ({
    icon: i.icon || gen.pickIcon(i.title + ' ' + (i.desc || '')),
    title: i.title || '', desc: i.desc || '',
    img: i.img || gen.imgQuery(i.title, topicImg),
  }));
}

// Build a fresh slide of a target type from extracted content.
function buildSlide(target, c, id, topicImg) {
  const base = { t: target, id, eyebrow: c.eyebrow, title: c.title, sub: c.sub || undefined, lead: c.lead || undefined, note: c.note || undefined };
  if (target === 'iconGrid' || target === 'quadrant' || target === 'future') {
    let items = c.items.length ? c.items : bulletsToItems(c.bullets);
    const max = target === 'future' ? 3 : target === 'quadrant' ? 4 : 6;
    return Object.assign(base, { cards: withCardImgs(items.slice(0, max), topicImg) });
  }
  if (target === 'flow' || target === 'pipeline') {
    let items = (c.items.length ? c.items : bulletsToItems(c.bullets)).slice(0, 6).map((i) => ({ icon: i.icon || gen.pickIcon(i.title + ' ' + (i.desc || '')), title: i.title, desc: i.desc }));
    const key = target === 'flow' ? 'steps' : 'phases';
    return Object.assign(base, { [key]: items, stats: c.stats && c.stats.length ? c.stats : undefined });
  }
  return null;
}

function reType(s, topicImg, L) {
  if (KEEP_TYPE.has(s.t) || DATA_TYPE.has(s.t)) return null;
  const c = extractContent(s);
  const target = decideType(c);
  if (!target) return null;
  if (target === s.t && Array.isArray(s.cards)) return null;          // already right
  const before = `${s.t}(${(c.items.length || c.bullets.length)} items)`;
  const fresh = buildSlide(target, c, s.id, topicImg);
  if (!fresh) return null;
  L(`re-type ${before} → ${target}`);
  return fresh;
}

// Drop content slides with no real payload.
function shouldDrop(s) {
  if (KEEP_TYPE.has(s.t)) return false;
  if (s.t === 'chart' && s.chart && (s.chart.cats || s.chart.vals)) return false;
  if (s.t === 'table' && s.columns) return false;
  if (s.t === 'stats' && s.stats && s.stats.length) return false;
  const c = extractContent(s);
  const has = c.items.length || c.bullets.length;
  const titleOK = c.title && c.title.trim();
  if (!has && !titleOK) return true;
  // a content slide with a title but zero items/bullets and no data is too thin
  if (!has && titleOK && !c.stats.length && !c.chart && !c.table) return true;
  return false;
}

function ensureStructure(spec, topic, L) {
  const topicImg = gen.imgQuery(topic);
  if (!spec.slides.length || spec.slides[0].t !== 'cover') {
    const firstTitle = (spec.slides.find((s) => s.title) || {}).title || topic;
    spec.slides.unshift({ t: 'cover', title: topic || firstTitle, img: topicImg, meta: spec.deck || '' });
    L('add cover (missing)');
  }
  if (spec.slides[spec.slides.length - 1].t !== 'closing') {
    spec.slides.push({ t: 'closing', title: (topic || '总结') + ' · 总结', thanks: '谢谢观看 · Thank You' });
    L('add closing (missing)');
  }
  const contentTitles = spec.slides.filter((s) => gen.CONTENT_KINDS.includes(s.t) && s.title).map((s) => ({ title: s.title, desc: (s.sub || s.lead || '').slice(0, 40) }));
  const hasAgenda = spec.slides.some((s) => s.t === 'agenda');
  if (!hasAgenda && contentTitles.length >= 4) {
    spec.slides.splice(1, 0, { t: 'agenda', title: '内容导航', items: contentTitles });
    L('add agenda (≥4 content slides)');
  }
}

function normalize(spec, topic, L) {
  // fill missing icons/imgs on grid cards
  const topicImg = gen.imgQuery(topic);
  for (const s of spec.slides) {
    if (Array.isArray(s.cards)) for (const c of s.cards) {
      if (!c.icon) c.icon = gen.pickIcon(c.title + ' ' + (c.desc || ''));
      if (!c.img) c.img = gen.imgQuery(c.title, topicImg);
    }
    if (Array.isArray(s.steps)) for (const c of s.steps) if (!c.icon) c.icon = gen.pickIcon(c.title + ' ' + (c.desc || ''));
    if (Array.isArray(s.phases)) for (const c of s.phases) if (!c.icon) c.icon = gen.pickIcon(c.title + ' ' + (c.desc || ''));
  }
  // renumber content eyebrows
  let n = 0;
  for (const s of spec.slides) {
    if (!gen.CONTENT_KINDS.includes(s.t)) continue;
    n++;
    if (s.eyebrow == null || /^\d+\s*·/.test(s.eyebrow)) s.eyebrow = `${String(n).padStart(2, '0')} · ${s.tag || gen.KIND_LABEL[s.t] || s.t}`;
    if (s.tag) delete s.tag;
  }
  gen.assignIds(spec.slides);
}

// ----------------------------- orchestrator -----------------------------

/**
 * beautifySpec(spec, opts) → { spec, log }.
 * opts: { mode:'aggressive'|'gentle', theme? }. aggressive (default) re-types slides to fit
 * content; gentle only prunes/balances/normalizes (respects the author's chosen layouts).
 */
function beautifySpec(input, opts) {
  opts = opts || {};
  const mode = opts.mode || 'aggressive';
  const log = [];
  const L = (m) => log.push(m);
  const spec = {
    deck: input.deck || input.title,
    theme: opts.theme || input.theme || 'healthcare',
    footerLabel: input.footerLabel,
    typography: input.typography,
    slides: (input.slides || []).map((s) => Object.assign({}, s)),
  };
  const topic = spec.deck || (spec.slides[0] && spec.slides[0].title) || '演示文稿';
  const topicImg = gen.imgQuery(topic);

  for (const s of spec.slides) pruneText(s, L);
  for (const s of spec.slides) balanceCounts(s, L);
  if (mode === 'aggressive') {
    for (let i = 0; i < spec.slides.length; i++) { const r = reType(spec.slides[i], topicImg, L); if (r) spec.slides[i] = r; }
  }
  const before = spec.slides.length;
  spec.slides = spec.slides.filter((s) => { if (shouldDrop(s)) { L(`drop thin/empty slide "${trunc(s.title || s.t, 20)}"`); return false; } return true; });
  if (spec.slides.length < before) L(`pruned ${before - spec.slides.length} thin/empty slide(s)`);

  ensureStructure(spec, topic, L);
  normalize(spec, topic, L);
  if (opts.theme) { spec.theme = opts.theme; L(`theme → ${opts.theme}`); }
  return { spec, log };
}

// ----------------------------- import any .pptx -----------------------------

/**
 * importPptx(pptxPath) → a rough spec extracted from an arbitrary .pptx (python-pptx).
 * Every content slide becomes a provisional iconGrid of its bullets; beautifySpec then re-types
 * each into the layout that actually fits. Returns { spec, slidesParsed }.
 */
function importPptx(pptxPath, opts) {
  opts = opts || {};
  const qa = require('./qa');
  const py = qa.findPython();
  const abs = path.resolve(pptxPath);
  if (!fs.existsSync(abs)) throw new Error('pptx not found: ' + abs);
  const script = `
import sys, json
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
prs = Presentation(sys.argv[1])

def walk(shapes, paras, tables):
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            walk(sh.shapes, paras, tables); continue
        if sh.has_table:
            tbl = sh.table
            tables.append([[c.text.strip() for c in row.cells] for row in tbl.rows]); continue
        if not sh.has_text_frame: continue
        for para in sh.text_frame.paragraphs:
            txt = ''.join(r.text for r in para.runs) if para.runs else para.text
            txt = txt.strip()
            if not txt: continue
            size = 0
            for r in para.runs:
                if r.font.size: size = max(size, r.font.size.pt)
            paras.append([txt, size])

out = []
for sl in prs.slides:
    paras, tables = [], []
    walk(sl.shapes, paras, tables)
    if not paras and not tables: continue
    title, bullets = '', []
    if paras:
        # title = the paragraph with the largest font (tie → earliest); the rest are bullets
        maxi = max(range(len(paras)), key=lambda i: paras[i][1])
        title = paras[maxi][0]
        bullets = [paras[i][0] for i in range(len(paras)) if i != maxi]
    rec = {'title': title, 'bullets': bullets}
    if tables:
        t = tables[0]
        if len(t) >= 2:
            rec['table'] = {'header': t[0], 'rows': t[1:]}
    out.append(rec)
print(json.dumps(out, ensure_ascii=False))
`;
  const res = spawnSync(py, ['-c', script, abs], { env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) throw new Error('importPptx failed (python-pptx):\n' + (res.stderr || '').split('\n').slice(-10).join('\n'));
  const raw = JSON.parse((res.stdout || '').trim().split('\n').pop());

  // map parsed slides → a rough spec (provisional iconGrids; beautify will re-type)
  const slides = raw.map((r, idx) => {
    if (r.table) {
      const header = r.table.header;
      const columns = header.map((h, i) => ({ header: h || ('col' + (i + 1)), key: 'c' + i }));
      const rows = r.table.rows.map((row) => { const o = {}; row.forEach((c, i) => { o['c' + i] = c; }); return o; });
      return { t: 'table', title: r.title || '数据表', columns, rows };
    }
    const cards = (r.bullets || []).map((b) => ({ title: b, desc: '' }));
    const slide = { t: 'iconGrid', title: r.title || ('第 ' + (idx + 1) + ' 页'), cards };
    return slide;
  });
  // first slide → cover, last → closing (if they look like title/ending slides)
  if (slides.length && slides[0].cards.length === 0) { slides[0] = { t: 'cover', title: slides[0].title }; }
  if (slides.length > 1 && slides[slides.length - 1].cards.length === 0) { slides[slides.length - 1] = { t: 'closing', title: slides[slides.length - 1].title }; }

  return { spec: { deck: (slides[0] && slides[0].title) || 'Imported Deck', theme: opts.theme || 'healthcare', slides }, slidesParsed: raw.length };
}

module.exports = { beautifySpec, importPptx, decideType, extractContent, trunc, weight, LIMITS };
