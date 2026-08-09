// lib/review.js — LLM-driven layout review + revision loop.
//
// After a build, lib/layout-qa produces a deterministic report (out-of-bounds / overlap /
// whitespace). This module turns that report into targeted LLM fixes and re-renders, closing
// the loop the user asked for: "llm 检查 ppt 内容，严禁大量留白".
//
//   reviewAndRevise(slides, report, deckBoxes, opts) -> revised slides
//     - freeform slides: the LLM re-places elements to eliminate overlaps / overflow / whitespace
//     - typed slides with whitespace: the LLM densifies that slide's content
//     - any slide with no issues is passed through untouched
// The orchestrator calls this, rebuilds, and repeats up to `maxIters` until layout-qa is clean.

const llm = require('./llm');
const { TOOLBOX } = require('./freeform');
const geo = require('./layout-qa'); // intersect / area for content-level detectors
const color = require('./color');

// Coarse fill category for a palette key | hex (light / dark / accent / none).
const PALCAT = { dark: 'dark', ink: 'dark', white: 'light', offWhite: 'light', cardTint: 'light', mintLt: 'light',
  primary: 'accent', mint: 'accent', coral: 'accent', amber: 'accent', violet: 'accent', teal: 'accent',
  slate: 'accent', muted: 'accent' };
function fillCat(f) {
  if (!f) return 'none';
  if (PALCAT[f]) return PALCAT[f];
  const h = String(f).replace('#', '');
  if (/^[0-9A-Fa-f]{6}$/.test(h)) return color.fillCategory(h);
  return 'other';
}

// Group a layout-qa report's issues by slide number.
function issuesBySlide(report) {
  const m = {};
  for (const i of (report.issues || [])) (m[i.slide] = m[i.slide] || []).push(i);
  return m;
}

function fmtIssues(list) {
  return list.map((i) => `- [${i.kind}] ${i.msg}`).join('\n');
}

// Detect the "big-number + one sentence in its own box, several per page" pattern — the most
// obvious AI-generation tell. A stat-tile = a rect/rrect panel containing a short text that starts
// with a digit. Flag any content slide with ≥2 of them so the review loop dismantles them.
function detectStatTiles(slides) {
  const issues = [];
  const isNum = (t) => /^[\s>≤<≈约超近]*[0-9０-９]/.test(String(t)) && String(t).replace(/\s/g, '').length <= 14;
  slides.forEach((s, i) => {
    if (s.t !== 'free' || s.role === 'cover' || s.role === 'closing') return;
    const els = s.elements || [];
    const panels = els.filter((e) => (e.k === 'rrect' || e.k === 'rect') && e.x != null);
    const texts = els.filter((e) => (e.k === 'text' || e.k === 'fit') && e.text != null);
    let tiles = 0;
    for (const p of panels) {
      const inside = texts.filter((t) => {
        const cx = (t.x || 0) + (t.w || 0) / 2, cy = (t.y || 0) + (t.h || 0) / 2;
        return cx >= p.x && cx <= p.x + (p.w || 0) && cy >= p.y && cy <= p.y + (p.h || 0);
      });
      if (inside.some((t) => isNum(t.text))) tiles++;
    }
    if (tiles >= 2) issues.push({
      slide: i + 1, severity: 'error', kind: 'stat-tiles',
      msg: `${tiles} 个"大数字+一句话"独立方块（AI 生成痕迹明显）：把这些数字改写进完整的要点/正文，或合并为一张图表/表格；不要用大数字方格`,
    });
  });
  return issues;
}

// Detect "too many big blocks" — except for listing/example pages, a slide should have ≤3 large
// blocks, not many small ones piled up. A "big block" is a rect/rrect panel ≥ 2.5in². A uniform
// grid of similar-sized panels (a legitimate 2×2 / 2×3 listing) is exempt.
function detectTooManyBlocks(slides) {
  const issues = [];
  const BIG = 2.5;
  // Only a genuine listing/cases archetype may exceed 3 big blocks (as a clean grid).
  const LISTING_ARCH = new Set(['card-grid']);
  slides.forEach((s, i) => {
    if (s.t !== 'free' || s.role === 'cover' || s.role === 'closing') return;
    const panels = (s.elements || []).filter((e) => (e.k === 'rrect' || e.k === 'rect') && e.x != null && e.w > 0 && e.h > 0 && e.w * e.h >= BIG);
    if (panels.length <= 3) return;
    const isListing = LISTING_ARCH.has(s._arch);
    if (isListing && panels.length <= 6) {
      // still flag a non-uniform listing (cluttered, not a clean grid)
      const areas = panels.map((p) => p.w * p.h);
      const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
      const uniform = areas.every((a) => Math.abs(a - mean) < mean * 0.4);
      if (uniform) return;
    }
    issues.push({
      slide: i + 1, severity: 'error', kind: 'too-many-blocks',
      msg: `${panels.length} 个大块面（除列举/案例外应 ≤3）：合并或删减到 ≤3 个大块面，或整理成规整的 2×2/2×3 列举网格；不要用很多小方块堆砌`,
    });
  });
  return issues;
}

// Detect images hidden behind an opaque panel drawn later (z-order bug): the image sits at the
// bottom layer, the panel on top covers it → an empty frame, image invisible.
function detectHiddenImages(slides) {
  const issues = [];
  slides.forEach((s, i) => {
    if (s.t !== 'free') return;
    const els = s.elements || [];
    els.forEach((e, j) => {
      if (e.k !== 'image' || e.x == null || !e.w || !e.h) return;
      const img = { x: e.x, y: e.y, w: e.w, h: e.h };
      for (let k = j + 1; k < els.length; k++) {
        const p = els[k];
        if (!((p.k === 'rrect' || p.k === 'rect') && p.x != null && p.w > 0)) continue;
        if (p.opacity) continue; // translucent overlay doesn't fully hide
        const it = geo.intersect(img, { x: p.x, y: p.y, w: p.w, h: p.h });
        if (it && geo.area(it) / geo.area(img) >= 0.5) {
          issues.push({
            slide: i + 1, severity: 'error', kind: 'hidden-image',
            msg: '图片被上层不透明方框遮挡（看不见）：把该图片在 elements 数组中移到遮挡方框之后，或删除遮挡的方框',
          });
          break;
        }
      }
    });
  });
  return issues;
}

// Revise ONE freeform slide's elements to fix its issues.
async function reviseFree(spec, issues, model, ctx) {
  const ctxSum = ctx ? ctx.summary(spec) : '';
  const j = await llm.askJson({
    model: model || 'sonnet', maxTokens: 3500, temperature: 0.3,
    system: 'You are a presentation layout engineer. You fix layout problems by repositioning '
            + 'and resizing elements. You NEVER change the wording/meaning of text — only geometry, '
            + 'and you may ADD elements to fill empty space. The canvas is 13.33" wide × 7.5" tall.',
    prompt:
      `这是一张 freeform 幻灯片，存在以下版式问题：\n${fmtIssues(issues)}\n\n` +
      `当前元素（JSON）：\n${JSON.stringify(spec.elements, null, 1)}\n\n` +
      `${TOOLBOX}\n\n` +
      (ctxSum ? ctxSum + '\n\n' : '') +
      `请修正全部问题：① 消除元素重叠与越界；② 用 fit/bullets 把文字填满盒子、填补大片留白；③ ★若存在多个"大数字+一句话"独立方块，改写为融入正文/要点的完整句子或图表/表格；④ ★若大块面过多（>3），合并或删减到 ≤3 个大块（列举/案例可整理成规整 2×2/2×3 网格）；⑤ ★若有图片被方框遮挡，把图片移到该方框之后（靠后=上层）或删掉遮挡方框；⑥ ★若有大块内容偏少/框内留白，补充更具体饱满的描述或 3-5 条要点让内容撑满方框；⑦ ★若有并列大块格式不统一，让它们结构一致（都配图、标题/描述结构相同）；⑧ ★若页面缺图，必须为每个大块/每个案例配一张相关真实图片（image 元素，英文搜图词），做到图文并茂——图片是版式主体而非可选装饰；⑨ 尽量保持原有信息，仅调整版式/坐标/层级或重组、充实内容。\n` +
      `充分利用整个内容区（y∈[2.1,6.9]），信息密度高、不留大片空白。\n` +
      `输出严格 JSON：{"elements":[ ...修正后的完整元素数组... ]}。`,
  });
  if (j && Array.isArray(j.elements) && j.elements.length) {
    // Regression guard: never accept a revision that adds overlaps. Inject the renderer's title
    // band + footer as synthetic boxes so encroaching on the title is also caught.
    const band = (spec.title && spec.role !== 'cover' && spec.role !== 'closing')
      ? [{ x: 0.6, y: 0.42, w: 12.13, h: 1.6 }, { x: 0.6, y: 7.05, w: 12.13, h: 0.4 }] : [];
    const before = countOverlaps(spec.elements, band), after = countOverlaps(j.elements, band);
    const kinds = issues.map((i) => i.kind).join(',');
    if (after > before) {
      console.warn(`  [review] slide revision rejected (would add overlaps ${before}→${after}); keeping original`);
      if (ctx) ctx.record(spec, { rejected: true, reason: `会新增重叠 ${before}→${after}`, issues: kinds });
      return null;
    }
    if (ctx) ctx.record(spec, { rejected: false, issues: kinds });
    return j.elements;
  }
  return null;
}

// Densify a TYPED slide whose only problem is large whitespace (renderer controls geometry, so
// we fix by adding/expanding content). Returns a revised spec or null.
async function densifyTyped(spec, issues, model) {
  const j = await llm.askJson({
    model: model || 'sonnet', maxTokens: 2500, temperature: 0.4,
    system: 'You make a presentation slide content-richer so it fills its layout with no large '
            + 'empty areas. Preserve the slide type and existing meaning; add concrete detail.',
    prompt:
      `这张幻灯片版式固定，但内容偏少导致大片留白：\n${fmtIssues(issues)}\n\n` +
      `当前 spec（JSON）：\n${JSON.stringify(spec, null, 1)}\n\n` +
      `请让内容更丰满以填满版面：补充更多卡片/条目/要点、把描述写得更具体充实（含数字或实例）、必要时补充 stats 或 bullets。保持 slide 的 t 字段和主题不变。\n` +
      `输出严格 JSON：完整的、修正后的单张 slide spec 对象。`,
  });
  if (j && j.t) return j;
  return null;
}

// C (context manager) for the freeform revise loop: per-slide revision history across iterations,
// compacted to the last N attempts. Fed back into reviseFree's prompt so the model doesn't repeat a
// fix the overlap guard already rejected — mirrors blank-harness's Context (bounded, compacts).
class ReviseContext {
  constructor(opts) { opts = opts || {}; this.keep = opts.keep || 3; this.hist = {}; this.compactions = 0; }
  _key(spec) { return String((spec && (spec.id || spec.n)) || (spec && spec.title) || 'slide'); }
  record(spec, entry) {
    const k = this._key(spec);
    (this.hist[k] = this.hist[k] || []).push(entry);
    if (this.hist[k].length > this.keep) { this.hist[k] = this.hist[k].slice(-this.keep); this.compactions++; }
  }
  summary(spec) {
    const h = this.hist[this._key(spec)];
    if (!h || !h.length) return '';
    return '【该页此前修订记录（不要重复会被拒的方案）】\n' + h.map((e, i) =>
      `第${i + 1}次：${e.rejected ? '被拒——' + (e.reason || '') : '已采纳'}；当时问题：${e.issues || '—'}`).join('\n');
  }
}

/**
 * Revise slides that have layout issues. Returns a NEW slides array (unmodified where clean).
 * opts: { model, onProgress, ctx }
 */
async function reviewAndRevise(slides, report, deckBoxes, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  const bySlide = issuesBySlide(report);
  const dirty = Object.keys(bySlide).map(Number);
  if (!dirty.length) { onProgress('review', '版式检查通过，无需修订。'); return slides; }

  onProgress('review', `${dirty.length} 张幻灯片有问题，交由 LLM 修订…`);
  const out = slides.map((s) => Object.assign({}, s));
  for (const n of dirty) {
    const spec = out[n - 1];
    if (!spec) continue;
    const issues = bySlide[n];
    onProgress('review:tick', `  · slide ${n} (${spec.t})：${issues.map((i) => i.kind).join('，')}`);
    try {
      if (spec.t === 'free') {
        const revised = await reviseFree(spec, issues, opts.model, opts.ctx);
        if (revised) out[n - 1].elements = revised;
      } else {
        // typed slide — only attempt to densify when the problem set is just whitespace
        const onlyWS = issues.every((i) => i.kind === 'whitespace');
        if (onlyWS) {
          const revised = await densifyTyped(spec, issues, opts.model);
          if (revised) { delete revised.id; out[n - 1] = revised; }
        }
      }
    } catch (e) {
      onProgress('review:warn', `  ⚠ slide ${n} 修订失败：${e.message}`);
    }
  }
  return out;
}

// Estimate wrapped line count for mixed CJK/latin text (mirrors lib/elements.js estLines).
function estLines(t, fsPt, boxW) {
  if (!t) return 0;
  const fsIn = fsPt / 72;
  let lines = 0;
  for (const seg of String(t).split('\n')) {
    let w = 0;
    for (const ch of seg) {
      if (/[　-鿿＀-￯]/.test(ch)) w += fsIn * 1.04;
      else if (ch === ' ' || ch === '\t') w += fsIn * 0.30;
      else w += fsIn * 0.56;
    }
    lines += Math.max(1, Math.ceil(w / Math.max(0.4, boxW - 0.18)));
  }
  return lines;
}
const centerInside = (e, p) => {
  const cx = (e.x || 0) + (e.w || 0) / 2, cy = (e.y || 0) + (e.h || 0) / 2;
  return cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h;
};

// Count overlaps directly from raw element geometry (no rendering needed). Used as a regression
// guard: a revision that introduces MORE overlaps than it fixes is rejected, so the loop never
// makes a slide worse. Mirrors layout-qa's conflict model (container↔container, text↔text).
function countOverlaps(elements, extraBoxes) {
  const M = { rrect: 'shape', rect: 'shape', oval: 'decor', text: 'text', fit: 'text', bullets: 'text', image: 'image', icon: 'badge', badge: 'badge' };
  const bs = (elements || []).filter((e) => e && e.x != null && e.w != null)
    .map((e) => ({ layer: M[e.k] || e.k, x: e.x, y: e.y, w: e.w, h: e.h != null ? e.h : (e.d || 0) }))
    .filter((b) => b.h > 0);
  // The renderer draws a title band + footer that aren't in the spec elements — inject them so the
  // guard also catches content encroaching on the title band (which layout-qa would flag).
  if (Array.isArray(extraBoxes)) for (const b of extraBoxes) bs.push(Object.assign({ layer: 'text' }, b));
  const isCon = (b) => (b.layer === 'image' || b.layer === 'shape') && (b.w * b.h) > 1.0;
  const isTxt = (b) => b.layer === 'text';
  let n = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    const tt = isTxt(a) && isTxt(b);
    if (!((isCon(a) && isCon(b)) || tt)) continue;
    const k = geo.intersect(a, b);
    if (!k) continue;
    const ar = geo.area(k);
    if (ar < (tt ? 0.35 : 0.5)) continue;
    // Two text boxes never legitimately overlap (even nested). For containers, one fully inside
    // another (e.g. an image filling its frame) is allowed.
    if (!tt && (geo.containment(a, b) >= 0.7 || geo.containment(b, a) >= 0.7)) continue;
    n++;
  }
  return n;
}

// Detect blocks whose content is too thin for their size (big frame, little text → internal
// whitespace). Estimates rendered text height vs the panel's available text area.
function detectThinBlocks(slides) {
  const issues = [];
  const BIG = 4.0;
  slides.forEach((s, i) => {
    if (s.t !== 'free' || s.role === 'cover' || s.role === 'closing') return;
    const els = s.elements || [];
    const panels = els.filter((e) => (e.k === 'rrect' || e.k === 'rect') && e.x != null && e.w * e.h >= BIG);
    panels.forEach((p, pi) => {
      const inner = els.filter((e) => ['text', 'fit', 'bullets', 'image', 'icon', 'badge'].includes(e.k) && centerInside(e, p));
      const cw = p.w - 0.4;
      const imgH = inner.filter((e) => e.k === 'image').reduce((m, e) => Math.max(m, e.h || 0), 0);
      const availH = p.h - imgH - 0.5;
      if (availH <= 0.6) return;
      let textH = 0;
      for (const e of inner) {
        if (e.k === 'text' || e.k === 'fit') textH += estLines(e.text, 14, cw) * (14 / 72) * 1.3 + 0.08;
        if (e.k === 'bullets') for (const it of (e.items || [])) textH += estLines(it, 14, cw) * (14 / 72) * 1.3 + 12 / 72;
      }
      if (textH < 0.5 * availH) issues.push({
        slide: i + 1, severity: 'error', kind: 'thin-block',
        msg: `第 ${pi + 1} 个大块内容偏少（约填 ${(textH / availH * 100).toFixed(0)}%，框内留白）：补充更具体、更饱满的描述或 3-5 条要点，让内容撑满方框`,
      });
    });
  });
  return issues;
}

// Detect inconsistent sibling blocks: parallel (same row) big blocks should share a structure —
// all have an image, or all use an icon, etc. Mixed features read as sloppy/AI-generated.
function detectInconsistentBlocks(slides) {
  const issues = [];
  const overlapFrac = (a, b) => {
    const o = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return o > 0 ? o / Math.min(a.h, b.h) : 0;
  };
  slides.forEach((s, i) => {
    if (s.t !== 'free' || s.role === 'cover' || s.role === 'closing') return;
    const els = s.elements || [];
    const panels = els.filter((e) => (e.k === 'rrect' || e.k === 'rect') && e.x != null && e.w * e.h >= 2.5);
    // cluster into rows by overlapping y
    const rows = [];
    for (const p of panels) {
      let row = rows.find((r) => r.some((q) => overlapFrac(p, q) >= 0.5));
      if (!row) { row = []; rows.push(row); }
      row.push(p);
    }
    for (const row of rows) {
      if (row.length < 2) continue;
      const feat = row.map((p) => {
        const inner = els.filter((e) => ['image', 'icon'].includes(e.k) && centerInside(e, p));
        const vis = inner.some((e) => e.k === 'image') ? 'img' : (inner.some((e) => e.k === 'icon') ? 'icon' : 'none');
        return vis + '/' + fillCat(p.fill); // e.g. "img/light", "none/dark"
      });
      const fills = row.map((p) => fillCat(p.fill));
      const fillMix = new Set(fills).size > 1;
      if (new Set(feat).size > 1) issues.push({
        slide: i + 1, severity: 'error', kind: 'inconsistent-blocks',
        msg: `并列的 ${row.length} 个大块格式不统一（${fillMix ? '填色：' + [...new Set(fills)].join('/') + '；' : ''}视觉：${[...new Set(feat.map((f) => f.split('/')[0]))].join('/')}）：让并列块完全一致——填色相同（都白底/都浅底/都深底）、都配图或都用图标、标题描述结构相同`,
      });
    }
  });
  return issues;
}

// Detect image-light slides. Every content page should be 图文并茂: at least one photo, and on a
// multi-block page each big block should carry an image (not just icons).
function detectImageLight(slides) {
  const issues = [];
  slides.forEach((s, i) => {
    if (s.t !== 'free' || s.role === 'cover' || s.role === 'closing') return;
    const els = s.elements || [];
    const imgs = els.filter((e) => e.k === 'image').length;
    const bigPanels = els.filter((e) => (e.k === 'rrect' || e.k === 'rect') && e.x != null && e.w * e.h >= 2.5);
    if (imgs === 0) issues.push({
      slide: i + 1, severity: 'error', kind: 'no-image',
      msg: '页面没有配图：要图文并茂，至少加 1 张与内容相关的真实配图（image 元素，英文搜图词）',
    });
    else if (bigPanels.length >= 2 && imgs < Math.min(bigPanels.length, 3)) issues.push({
      slide: i + 1, severity: 'error', kind: 'too-few-images',
      msg: `${bigPanels.length} 个并列大块只有 ${imgs} 张图：每个大块都应配一张图，做到图文并茂`,
    });
  });
  return issues;
}

// V — "floating junk big text": ghost backdrop glyphs that are too large or sit over content, so
// they read as stray text instead of a subtle backdrop. renderFree already forces faint + caps size
// at 200, but a 200pt glyph or one overlapping text still dominates.
function detectGhostDominance(slides) {
  const issues = [];
  slides.forEach((s, i) => {
    if (s.t !== 'free') return;
    const els = s.elements || [];
    const ghosts = els.filter((e) => e.k === 'ghost' && e.x != null && e.w > 0);
    if (!ghosts.length) return;
    const content = els.filter((e) => ['text', 'fit', 'bullets', 'image', 'icon', 'badge'].includes(e.k) && e.x != null && e.w > 0);
    ghosts.forEach((g) => {
      const size = g.size || 120;
      const overContent = content.some((c) => { const it = geo.intersect(g, c); return it && geo.area(it) > 0.2; });
      if (size > 120 || overContent) issues.push({
        slide: i + 1, severity: 'error', kind: 'ghost-dominant',
        msg: `背景大字"${String(g.text || '').slice(0, 8)}"过于显眼(size=${size}${overContent ? ' 且压住内容' : ''})：缩小到 size≤80 且不压正文，或直接删除——它只能是底层淡淡点缀`,
      });
    });
  });
  return issues;
}

// V — text that overflows its box. Fixed-size 'text' can spill; 'fit'/'bullets' auto-shrink, but if
// even at min size the content exceeds the box, it still overflows.
function detectTextOverflow(slides) {
  const issues = [];
  slides.forEach((s, i) => {
    if (s.t !== 'free') return;
    (s.elements || []).forEach((e) => {
      if (!['text', 'fit', 'bullets'].includes(e.k) || e.x == null || !e.w) return;
      const isText = e.k === 'text';
      const fs = isText ? (e.size || 14) : (e.min || 11); // fit/bullets: worst case at min size
      const cw = Math.max(0.4, (e.w || 4) - 0.18);
      const items = e.k === 'bullets' ? (e.items || []) : [e.text || ''];
      let lines = 0;
      items.forEach((it) => { lines += estLines(it, fs, cw); });
      const lineH = (fs / 72) * (isText ? 1.3 : 1.2);
      const needH = lines * lineH + (e.k === 'bullets' ? items.length * (12 / 72) : 0.1);
      if (needH > (e.h || 1) + 0.05) issues.push({
        slide: i + 1, severity: 'error', kind: 'text-overflow',
        msg: `文字超出方框(约需 ${needH.toFixed(2)}"，方框 ${(e.h || 1).toFixed(2)}")：缩小字号、加高方框或精简文字，确保文字在方框内部`,
      });
    });
  });
  return issues;
}

module.exports = { reviewAndRevise, reviseFree, densifyTyped, issuesBySlide, ReviseContext, detectStatTiles, detectTooManyBlocks, detectHiddenImages, detectThinBlocks, detectInconsistentBlocks, detectImageLight, detectGhostDominance, detectTextOverflow, countOverlaps };
