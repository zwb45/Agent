// lib/blank-verify.js — bridge between the PPT-generation review/revise loop and the standalone
// blank-harness whitespace detector.
//
// The orchestrator's buildWithReview() loop checks each built deck for fixable layout problems and
// hands them to the LLM to revise. This module runs the (independent, self-contained) blank-harness
// over the freshly built deck — which reads the deck's captured geometry as DATA (<deck>.layout.json
// / .spec.json, written by harness.js build()) — and turns its confirmed whitespace regions into the
// same {slide,severity,kind,msg} issue shape layout-qa emits, so the existing review/revise machinery
// consumes them unchanged.
//
// Why this exists alongside layout-qa: both compute maximal-empty-rectangle geometry, but blank-harness
// adds an LLM brain that filters the geometry sensor's false positives (benchmark precision 100%). So
// it is the AUTHORITATIVE whitespace verifier in the loop; layout-qa keeps handling out-of-bounds +
// overlap. See agent.md (决策一) for the design rationale.

const path = require('path');
const detect = require('../blank-harness/detect'); // self-contained: does NOT import the PPT harness
const geo = require('../blank-harness/geometry');

const SLIDE_AREA = geo.SLIDE_AREA; // 13.33 × 7.5 = 99.975 in²
// Hero pages are intentionally airy/full-bleed — exempt from whitespace (matches layout-qa's `exempt`
// map and the blank-harness LLM brain's prompt). Applied here so the geometry-only path doesn't
// regress hero pages the way the LLM path wouldn't.
const HERO_ROLES = new Set(['cover', 'closing', 'divider']);

/**
 * Run whitespace detection over a built deck.
 * opts: { useLLM(true), model, onLog, maxChars }
 *   - useLLM:true  → blank-harness agentic detect (geometry sensor + LLM filter; precise)
 *   - useLLM:false → geometry-only fast path (no LLM call; noisier)
 * Returns blank-harness's result: { slides:[{n,role,blanks:[{x,y,w,h,area,severity,reason,kind}]}], ... }
 */
async function verifyBlanks(file, opts) {
  opts = opts || {};
  const abs = path.resolve(file);
  if (opts.useLLM === false) return detectGeometryOnly(abs);
  // The blank-harness LLM client resolves only 'haiku'/'sonnet' tiers (+ raw ids). 'opus' is not a
  // tier there, so coerce to 'sonnet' (more than enough for whitespace verification).
  const model = (!opts.model || opts.model === 'opus') ? 'sonnet' : opts.model;
  return detect.detect(abs, {
    model,
    maxChars: opts.maxChars,
    onLog: opts.onLog || (() => {}),
  });
}

// Geometry-only path (mirrors blank-harness/blankcheck.js detectNoLLM). Reimplemented here from the
// exported primitives (loadDeck + candidatesFor + mergeOverlapping) so the self-contained blank-harness
// stays untouched. Candidates come back severity 'info' (unverified); blankIssues() treats 'info' as a
// 'warn'-level signal so geometry-only mode still feeds the loop (just with lower confidence).
function detectGeometryOnly(abs) {
  const deck = detect.loadDeck(abs);
  const slides = deck.slides.map((s) => {
    const c = geo.candidatesFor(s);
    const blanks = c.regions
      .map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, area: r.area, severity: 'info', reason: '', kind: 'blank-rect' }))
      .concat(c.thin.map((t) => ({ x: t.panel.x, y: t.panel.y, w: t.panel.w, h: t.panel.h, area: t.panel.w * t.panel.h, severity: 'info', reason: '框大字少', kind: 'thin-block' })));
    return { n: s.n, role: s.role, blanks: geo.mergeOverlapping(blanks) };
  });
  return { deckPptx: abs, slides, summary: '(geometry only, no LLM)', steps: 0, toolCalls: 0, repeatedCalls: 0, compactions: 0 };
}

/**
 * Convert a blank-harness result into layout-qa-shaped issues the review/revise loop consumes.
 *  - severity: high/medium → 'error' (drives revision); low/info → 'warn'.
 *  - kind: always 'whitespace' so the typed-slide densify gate (issues.every(i => i.kind === 'whitespace'))
 *    is satisfied and densification fires too. The msg carries coordinates + the specific fix.
 */
function blankIssues(result) {
  const out = [];
  for (const s of (result && result.slides) || []) {
    if (HERO_ROLES.has(s.role)) continue; // cover/closing/divider: intentional whitespace, never reported
    for (const b of (s.blanks || [])) {
      if (b.severity === 'uncertain') continue; // routed to uncertainBlanks() for human confirmation
      if (!isFinite(b.x) || !isFinite(b.w) || b.w <= 0 || b.h <= 0) continue;
      const sev = (b.severity === 'high' || b.severity === 'medium') ? 'error' : 'warn';
      const pct = SLIDE_AREA ? (b.area / SLIDE_AREA * 100) : 0;
      const loc = `约 ${pct.toFixed(0)}%，位于 x${b.x.toFixed(1)} y${b.y.toFixed(1)}，${b.w.toFixed(1)}"×${b.h.toFixed(1)}"`;
      const msg = b.kind === 'thin-block'
        ? `框大字少（${loc}）${b.reason ? '— ' + b.reason + '；' : ''}补充更具体饱满的描述或 3-5 条要点让内容撑满方框`
        : `大片留白（${loc}）${b.reason ? '— ' + b.reason + '；' : ''}用 fit/bullets/相关配图等把该区域填满`;
      out.push({ slide: s.n, severity: sev, kind: 'whitespace', msg, box: { x: b.x, y: b.y, w: b.w, h: b.h } });
    }
  }
  return out;
}

/**
 * Blanks the LLM judge couldn't confidently classify (intentional minimal vs under-filled) — surfaced
 * for HUMAN confirmation via the loop's onUncertain callback instead of being auto-revised.
 * Returns [{slide, severity:'uncertain', kind:'whitespace', reason, msg, box:{x,y,w,h}}].
 */
function uncertainBlanks(result) {
  const out = [];
  for (const s of (result && result.slides) || []) {
    if (HERO_ROLES.has(s.role)) continue;
    for (const b of (s.blanks || [])) {
      if (b.severity !== 'uncertain') continue;
      if (!isFinite(b.x) || !isFinite(b.w) || b.w <= 0 || b.h <= 0) continue;
      const pct = SLIDE_AREA ? (b.area / SLIDE_AREA * 100) : 0;
      const msg = `第 ${s.n} 页约 ${pct.toFixed(0)}% 空白(x${b.x.toFixed(1)} y${b.y.toFixed(1)}，${b.w.toFixed(1)}"×${b.h.toFixed(1)}")——模型不确定是否刻意留白${b.reason ? '：' + b.reason : ''}。保留？`;
      out.push({ slide: s.n, severity: 'uncertain', kind: 'whitespace', reason: b.reason || '', msg, box: { x: b.x, y: b.y, w: b.w, h: b.h } });
    }
  }
  return out;
}

module.exports = { verifyBlanks, blankIssues, uncertainBlanks, detectGeometryOnly };
