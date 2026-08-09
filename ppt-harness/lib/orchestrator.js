// lib/orchestrator.js — single entry point for "topic → rich .pptx".
//
//   generateDeck(topic, opts) -> { file, outline, brief, slides }
//
// Stages (each reports via opts.onProgress(stage, detail)):
//   1. research   — lib/research.js : web gather + aggregate → research brief
//   2. outline    — lib/outline.js   : brief → grounded outline JSON
//   3. compile    — lib/generate.js  : outline → slides (auto icons/images/cover/agenda/closing)
//   4. validate   — lib/schema.js    : structural check before handing to pptxgenjs
//   5. build      — harness.js build : slides → .pptx + spec.json + preview PNGs
//
// opts:
//   out, depth, model, aggModel, pages, theme, style, useImages(true), runQA(true),
//   renderPreview(true), saveArtifacts(true)  — writes <out>.brief.json + <out>.outline.json
//   onProgress(stage, detail), onWarn(detail)

const path = require('path');
const fs = require('fs');
const { build } = require('../harness');
const { outlineToSlides } = require('./generate');
const { validateSlides } = require('./schema');
const styleMod = require('./style');
const { research } = require('./research');
const { composeOutline } = require('./outline');
const { composeFreeformDeck } = require('./freeform-deck');
const review = require('./review');
const { reviewAndRevise } = review;
const blankVerify = require('./blank-verify');

function slug(s) {
  return String(s || 'deck').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 40);
}

// pptxgenjs accepts only 6-digit hex (or a SchemeColor) for `color`. LLM-authored content
// sometimes emits semantic names ("green", "amber", "red"). Map known names to hex, and
// drop anything else so it falls back to the renderer's default instead of erroring to black.
const COLOR_NAMES = {
  green: '2DBE9E', mint: '2DBE9E', teal: '2DBE9E', ok: '2DBE9E', success: '2DBE9E',
  positive: '2DBE9E', active: '2DBE9E', pass: '2DBE9E', approved: '2DBE9E',
  amber: 'F2B05E', orange: 'F2B05E', yellow: 'F2B05E', warn: 'F2B05E', warning: 'F2B05E',
  pending: 'F2B05E', caution: 'F2B05E',
  red: 'EF6F6C', coral: 'EF6F6C', danger: 'EF6F6C', error: 'EF6F6C', fail: 'EF6F6C',
  risk: 'EF6F6C', negative: 'EF6F6C',
  blue: '157F8B', primary: '157F8B', info: '157F8B',
  violet: '8B7BD8', purple: '8B7BD8',
  gray: '8A9BA8', grey: '8A9BA8', muted: '8A9BA8', neutral: '8A9BA8', slate: '8A9BA8',
};
function sanitizeColors(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'color' && typeof v === 'string') {
      const hex = v.replace(/^#/, '').trim();
      if (/^[0-9A-Fa-f]{6}$/.test(hex)) obj[k] = hex;
      else if (COLOR_NAMES[v.toLowerCase()]) obj[k] = COLOR_NAMES[v.toLowerCase()];
      else delete obj[k]; // unknown name → drop, renderer uses its default
    } else if (typeof v === 'object') {
      sanitizeColors(v);
    }
  }
  return obj;
}
function defaultOut(topic, cwd, noImages) {
  return path.join(cwd || process.cwd(), 'output', slug(topic) + (noImages ? '-noimg' : '') + '.pptx');
}

// Resolve the build options from an outline object (mirrors generate.js CLI wiring).
function buildOptsFromOutline(o, opts) {
  const d = o.design || {};
  const buildOpts = {
    palette: d.palette || o.palette,
    theme: opts.theme || d.theme || o.theme || ((d.palette || o.palette) ? undefined : 'healthcare'),
    style: opts.style || d.style || o.style,
    header: d.header || o.header, cover: d.cover || o.cover, card: d.card || o.card, decorate: d.decorate || o.decorate,
    typography: d.typography || o.typography,
    title: o.topic || o.title || 'PPT Harness Deck',
    footerLabel: o.footerLabel || o.topic,
  };
  // No design authored? auto-pick a style from the topic so different topics look different.
  if (!buildOpts.style && !buildOpts.header && !buildOpts.cover && !buildOpts.card && !buildOpts.decorate) {
    buildOpts.style = styleMod.pickStyleForTopic(o.topic || 'deck');
  }
  return buildOpts;
}

/**
 * Full research-driven deck generation.
 */
async function generateDeck(topic, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  const onWarn = opts.onWarn || ((d) => console.warn('  ⚠ ' + d));
  const noImages = opts.useImages === false;
  const out = path.resolve(opts.out || defaultOut(topic, opts.cwd, noImages));

  // 1) RESEARCH ----------------------------------------------------------------
  const brief = await research(topic, {
    depth: opts.depth || 'standard',
    model: opts.model || 'haiku',
    aggModel: opts.aggModel || 'sonnet',
    onProgress: (p, d) => onProgress('research:' + p, d),
  });

  // 2) OUTLINE -----------------------------------------------------------------
  onProgress('outline', '根据研究简报撰写内容丰满的大纲…');
  const outline = await composeOutline(topic, brief, {
    model: opts.aggModel || 'sonnet',
    pages: opts.pages,
    theme: opts.themeHint, style: opts.styleHint,
  });
  onProgress('outline', `大纲就绪：${outline.sections.length} 个内容页（编译器会再加封面/导览/结语）。`);

  if (opts.saveArtifacts !== false) {
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch {}
    fs.writeFileSync(out + '.outline.json', JSON.stringify(outline, null, 2));
    fs.writeFileSync(out + '.brief.json', JSON.stringify(brief, null, 2));
    onProgress('outline', '已保存大纲与研究简报（.outline.json / .brief.json）。');
  }

  return buildFromOutline(outline, { ...opts, out, brief, onProgress, onWarn });
}

/**
 * (Re)build a deck from an already-authored outline object. Used for follow-up edits in the
 * REPL ("换成 berry 主题", "去掉配图") without redoing research.
 */
async function buildFromOutline(outline, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  const onWarn = opts.onWarn || ((d) => console.warn('  ⚠ ' + d));
  const noImages = opts.useImages === false;
  const out = path.resolve(opts.out || defaultOut(outline.topic, opts.cwd, noImages));

  // 3) COMPILE -----------------------------------------------------------------
  const slides = outlineToSlides(outline);
  sanitizeColors(slides); // normalize LLM color names → hex (or drop) before pptxgenjs sees them
  onProgress('compile', `编译为 ${slides.length} 张幻灯片（${slides.map((s) => s.t).join(', ')}）。`);

  // 4) VALIDATE ----------------------------------------------------------------
  const v = validateSlides(slides);
  if (!v.ok) {
    onWarn('校验发现问题，将尝试继续构建（部分页面可能缺失）：');
    v.errors.forEach((e) => onWarn('  ✗ ' + e));
  }
  v.warnings.forEach((w) => onWarn('  ⚠ ' + w));

  // 5) BUILD -------------------------------------------------------------------
  const bOpts = buildOptsFromOutline(outline, opts);
  onProgress('build', `渲染 .pptx（${noImages ? '离线 · 无配图' : '在线 · 带配图'}）…`);
  const file = await build(Object.assign({}, bOpts, {
    slides, out, useImages: !noImages,
    runQA: opts.runQA !== false, renderPreview: opts.renderPreview !== false,
    onLayout: opts.onLayout, // forward layout-qa report to the review/revise loop
  }));
  onProgress('build', '完成 → ' + file);
  return { file, outline, brief: opts.brief || null, slides, buildOpts: bOpts };
}

module.exports = { generateDeck, generateFreeformDeck, buildFromOutline, buildWithReview,
  buildOptsFromOutline, defaultOut, slug };

/**
 * Freeform generation: the LLM decides every slide's layout (no hardcoded templates), then a
 * build → layout-qa → review/revise loop polishes overlaps / overflow / whitespace until clean.
 * opts: { out, depth, model, aggModel, pages, theme, style, useImages, renderPreview,
 *         maxIters, onProgress, onWarn, saveArtifacts }
 */
async function generateFreeformDeck(topic, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  const onWarn = opts.onWarn || ((d) => console.warn('  ⚠ ' + d));
  const noImages = opts.useImages === false;
  const out = path.resolve(opts.out || defaultOut(topic, opts.cwd, noImages));

  // 1) research (same grounded brief as the typed path)
  const brief = await research(topic, {
    depth: opts.depth || 'standard', model: opts.model || 'haiku', aggModel: opts.aggModel || 'sonnet',
    onProgress: (p, d) => onProgress('research:' + p, d),
  });

  // 2) compose a fully freeform deck (varied archetype per slide)
  const { slides } = await composeFreeformDeck(topic, brief, {
    model: opts.aggModel || 'sonnet', pages: opts.pages,
    onProgress: (p, d) => onProgress(p, d),
  });

  if (opts.saveArtifacts !== false) {
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch {}
    fs.writeFileSync(out + '.brief.json', JSON.stringify(brief, null, 2));
  }

  // 3) build → layout-qa → review/revise loop
  return buildWithReview(slides, {
    out, brief, useImages: !noImages, renderPreview: opts.renderPreview,
    theme: opts.theme, style: opts.style, title: topic, footerLabel: topic,
    maxIters: opts.maxIters, model: opts.aggModel || 'sonnet',
    blankCheck: opts.blankCheck, blankLLM: opts.blankLLM, blankModel: opts.blankModel,
    onUncertain: opts.onUncertain,
    saveArtifacts: opts.saveArtifacts,
    onProgress, onWarn,
  });
}

/**
 * The freeform path's execution loop — the "E" of its H = (E,T,C,S,L,V) harness mapping:
 *   E  this bounded loop: build → verify → revise → re-render, until clean or maxIters
 *   T  lib/freeform-tools.js (validated element registry) + lib/registry.js
 *   C  ReviseContext (per-slide revision history, fed back to reviseFree)
 *   S  deck sidecars written by build() (.spec/.layout/.slides.json)
 *   L  onProgress / onWarn / onUncertain callbacks (and per-iteration review events)
 *   V  layout-qa + review.* detectors (incl. ghost/overflow/hidden-image) + blank-verify
 * Used by the freeform path (and reusable for any slides array).
 */
async function buildWithReview(initialSlides, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  const onWarn = opts.onWarn || (() => {});
  const maxIters = opts.maxIters != null ? opts.maxIters : 3;
  const out = path.resolve(opts.out || defaultOut('deck', opts.cwd, opts.useImages === false));
  const noImages = opts.useImages === false;

  let cur = initialSlides.map((s) => Object.assign({}, s));
  sanitizeColors(cur);
  const bOpts = buildOptsFromOutline({ topic: opts.title, design: {} }, opts);
  let file = out, lastReport = null;
  // Whitespace verification: the independent blank-harness (LLM-verified; see lib/blank-verify.js) is
  // the authoritative whitespace source — its findings REPLACE layout-qa's own whitespace issues each
  // round. Only runs when the loop actually iterates (maxIters >= 1); a one-shot rebuild (maxIters:0,
  // e.g. chat.js's cheap rebuild) skips it to stay fast. Override explicitly with opts.blankCheck.
  const blankCheck = opts.blankCheck != null ? opts.blankCheck : maxIters >= 1;
  const blankLLM = opts.blankLLM !== false;
  const revCtx = new review.ReviseContext(); // C: per-slide revision history, fed back to reviseFree

  for (let iter = 0; iter <= maxIters; iter++) {
    let report, boxes;
    const isFinal = iter === maxIters;
    file = await build(Object.assign({}, bOpts, {
      slides: cur, out, useImages: !noImages,
      runQA: true, renderPreview: false, // preview only on the truly final pass
      onLayout: (r, bx) => { report = r; boxes = bx; },
    }));
    lastReport = report;
    // augment with content-level checks the geometry pass can't see
    const tileIssues = review.detectStatTiles(cur);
    const blockIssues = review.detectTooManyBlocks(cur);
    const hiddenImgIssues = review.detectHiddenImages(cur);
    const thinIssues = review.detectThinBlocks(cur);
    const inconsIssues = review.detectInconsistentBlocks(cur);
    const imgIssues = review.detectImageLight(cur);
    const ghostIssues = review.detectGhostDominance(cur);
    const overflowIssues = review.detectTextOverflow(cur);
    const contentIssues = tileIssues.concat(blockIssues).concat(hiddenImgIssues).concat(thinIssues).concat(inconsIssues).concat(imgIssues).concat(ghostIssues).concat(overflowIssues);
    // Whitespace: when blank-check is on, the LLM-verified blank-harness is authoritative — its
    // findings REPLACE layout-qa's own whitespace issues (same geometry + an FP-filtering brain).
    let wsIssues = (report.issues || []).filter((i) => i.kind === 'whitespace');
    // Skip blank-check on the final iteration: the loop breaks right after (no revision follows), so
    // an LLM agent run there is wasted cost (and an `onUncertain` prompt there could never be acted on).
    if (blankCheck && !isFinal) {
      try {
        const br = await blankVerify.verifyBlanks(file, {
          useLLM: blankLLM, model: opts.blankModel || opts.model,
          onLog: (m) => onProgress('blankcheck:tick', m),
        });
        wsIssues = blankVerify.blankIssues(br);
        // Blanks the LLM couldn't confidently classify → ask the user (interactive) or keep+warn.
        const uncertain = blankVerify.uncertainBlanks(br);
        let extra = '';
        if (uncertain.length) {
          if (typeof opts.onUncertain === 'function') {
            const decisions = await opts.onUncertain(uncertain);
            const confirmed = (decisions || []).filter((d) => d && !d.keep);
            confirmed.forEach((d) => wsIssues.push({
              slide: d.slide, severity: 'error', kind: 'whitespace',
              msg: d.msg || '用户确认需补充的留白', box: d.box,
            }));
            extra = `；另有 ${uncertain.length} 处待确认，你选择补充 ${confirmed.length} 处`;
          } else {
            uncertain.forEach((u) => onWarn('留白待确认（默认保留，未自动修订）：' + u.msg));
            extra = `；另有 ${uncertain.length} 处待确认（默认保留）`;
          }
        }
        onProgress('blankcheck', (wsIssues.length
          ? `留白核验：${wsIssues.length} 处留白`
          : '留白核验通过：未发现需处理的留白')
          + `（${blankLLM ? 'LLM 核验' : '纯几何'}）` + extra + '。');
      } catch (e) {
        onWarn('留白核验失败，回退到 layout-qa 几何留白检测：' + e.message);
      }
    }
    const geomIssues = (report.issues || []).filter((i) => i.kind !== 'whitespace');
    const issues = geomIssues.concat(wsIssues).concat(contentIssues);
    const extra = [];
    if (tileIssues.length) extra.push(`${tileIssues.length} 处大数字方格`);
    if (blockIssues.length) extra.push(`${blockIssues.length} 页块过多`);
    if (hiddenImgIssues.length) extra.push(`${hiddenImgIssues.length} 处图片被遮挡`);
    if (thinIssues.length) extra.push(`${thinIssues.length} 个块内容偏少`);
    if (inconsIssues.length) extra.push(`${inconsIssues.length} 处并列块不统一`);
    if (imgIssues.length) extra.push(`${imgIssues.length} 页缺图`);
    if (ghostIssues.length) extra.push(`${ghostIssues.length} 处背景大字过大`);
    if (overflowIssues.length) extra.push(`${overflowIssues.length} 处文字超框`);
    const eCnt = issues.filter((i) => i.severity === 'error').length;
    const lqaLine = issues.length === 0
      ? '版式检查通过：无溢出 / 重叠 / 大片留白。'
      : `版式检查：${eCnt} 个问题，${issues.length - eCnt} 个警告。`;
    onProgress('layout-qa', lqaLine + (extra.length ? ' 另有 ' + extra.join('、') + '。' : ''));
    const hasFixable = issues.length > 0;
    if (!hasFixable || isFinal) break;
    const mergedReport = issues === report.issues ? report : Object.assign({}, report, { issues, errors: issues.filter((i) => i.severity === 'error') });
    onProgress('review', `第 ${iter + 1}/${maxIters} 轮修订（${issues.length} 个问题）…`);
    const revised = await reviewAndRevise(cur, mergedReport, boxes, { model: opts.model, onProgress, ctx: revCtx });
    if (revised === cur) break; // nothing changed
    cur = revised;
    sanitizeColors(cur);
  }

  // final pass with preview rendering (if requested) so the user gets PNGs of the polished deck
  if (opts.renderPreview !== false) {
    file = await build(Object.assign({}, bOpts, {
      slides: cur, out, useImages: !noImages,
      runQA: true, renderPreview: true,
      onLayout: (r) => { lastReport = r; },
    }));
    onProgress('layout-qa', layoutQASummary(lastReport));
  }

  if (opts.saveArtifacts !== false) {
    try { fs.writeFileSync(out + '.slides.json', JSON.stringify(cur, null, 2)); } catch {}
  }
  onProgress('done', '完成 → ' + file);
  return { file, slides: cur, brief: opts.brief || null, layout: lastReport };
}

function layoutQASummary(report) {
  if (!report) return '';
  if (!report.issues.length) return '版式检查通过：无溢出 / 重叠 / 大片留白。';
  const e = report.errors.length, w = report.issues.length - e;
  return `版式检查：${e} 个错误，${w} 个留白警告。`;
}
