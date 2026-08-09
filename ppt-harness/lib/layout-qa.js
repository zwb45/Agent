// lib/layout-qa.js — deterministic layout validation over captured element geometry.
//
// The harness records every box it places (see the E-recorder in harness.js build()). This
// module turns those box logs into a structural QA report addressing four failure modes:
//   (a) out-of-bounds — a box extends past the slide edge [0,W]×[0,H]
//   (b) overlap       — two content boxes collide (neither contains the other; decorations exempt)
//   (c) whitespace    — a large empty region survives (content not filling the canvas)
//
// All pure rectangle math — no LLM, no rendering. Used both to print a QA report after build
// AND to drive the LLM review/revise loop (lib/review.js) with concrete, fixable feedback.

const W = 13.33, H = 7.5;
const SLIDE_AREA = W * H;

// ---- rectangle helpers (inches; boxes are {x,y,w,h}) ----
function area(b) { return Math.max(0, b.w) * Math.max(0, b.h); }
function intersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// fraction of inner covered by outer (0..1)
function containment(inner, outer) {
  const ai = area(inner);
  if (ai <= 0) return 0;
  const k = intersect(inner, outer);
  return k ? area(k) / ai : 0;
}

// Layers that can legitimately collide. Decorations (background ovals/dots/bars) and
// chrome (header/footer text) are exempt from overlap checks.
const SOLID = new Set(['card', 'image', 'text', 'badge', 'shape', 'table']);

/**
 * Analyze a full deck's captured geometry.
 * @param {Object} deckBoxes - { [slideNum]: [ {layer,x,y,w,h,label}, ... ] }
 * @param {Object} opts - { boundsTol, overlapMin, whitespaceAreaRatio, whitespaceMinDim, fillLayers }
 * @returns { ok, issues:[{slide,severity,kind,msg,box?}], perSlide:[{slide,coverage,largestEmpty}] }
 */
function analyze(deckBoxes, opts) {
  opts = opts || {};
  const boundsTol = opts.boundsTol != null ? opts.boundsTol : 0.02;
  const overlapMin = opts.overlapMin != null ? opts.overlapMin : 0.12; // in² to count as a real collision
  const wsAreaRatio = opts.whitespaceAreaRatio != null ? opts.whitespaceAreaRatio : 0.14;
  const wsMinDim = opts.whitespaceMinDim != null ? opts.whitespaceMinDim : 1.1;
  // NOTE: 'bg' (the full-slide background fill) is intentionally NOT a fill layer — a background
  // color isn't "content", so counting it would mask all real whitespace (every page looks 100% full).
  const fillLayers = opts.fillLayers || ['card', 'image', 'text', 'badge', 'shape', 'table', 'chart', 'chrome'];
  const exempt = opts.exempt || {}; // slide numbers exempt from overlap + whitespace (hero slides)

  // What actually conflicts: two solid CONTAINERS colliding, or two TEXT blocks colliding
  // (unreadable). Text/icons sitting ON a panel (text↔shape/card) is intentional layering in
  // freeform and in typed decks (text inside a card) — NOT a conflict. A freeform panel is drawn
  // as a 'shape' (rrect/rect); large shapes (>1in², i.e. card/panel-sized) count as containers so
  // two overlapping panels ARE caught, while tiny accent bars/dividers stay exempt. Badges, decor
  // and chrome are exempt from overlap entirely.
  const isContainer = (b) => ['card', 'image', 'table', 'chart'].includes(b.layer)
    || (b.layer === 'shape' && area(b) > 1.0);
  const isText = (b) => b.layer === 'text';
  const isBgSize = (b) => area(b) >= 0.8 * SLIDE_AREA;

  const issues = [];
  const perSlide = [];
  const slides = Object.keys(deckBoxes).map(Number).sort((a, b) => a - b);

  for (const n of slides) {
    const boxes = (deckBoxes[n] || []).filter((b) => isFinite(b.x) && isFinite(b.w) && b.w > 0 && b.h > 0);

    // (a) out-of-bounds ------------------------------------------------------
    // Decorations (ovals/dots/bars) intentionally bleed off-edge (e.g. decorate() at y:-2.0) —
    // exempt them. Everything else must stay on the slide.
    for (const b of boxes) {
      if (b.layer === 'decor') continue;
      const overL = b.x < -boundsTol;
      const overR = b.x + b.w > W + boundsTol;
      const overT = b.y < -boundsTol;
      const overB = b.y + b.h > H + boundsTol;
      if (overL || overR || overT || overB) {
        const dx = (overL ? b.x : 0) + (overR ? (b.x + b.w - W) : 0);
        const dy = (overT ? b.y : 0) + (overB ? (b.y + b.h - H) : 0);
        issues.push({
          slide: n, severity: 'error', kind: 'out-of-bounds',
          msg: `内容超出幻灯片边界（${labelOf(b)}：越出 ${dx.toFixed(2)}"×${dy.toFixed(2)}）`,
          box: b,
        });
      }
    }

    // (b) overlap (container↔container, text↔text only) -----------------------
    if (!exempt[n]) {
      const check = boxes.filter((b) => !isBgSize(b) && (isContainer(b) || isText(b)));
      // text↔text: require a meaningful overlap (0.35in²) so intentional side-by-side boxes in the
      // typed renderers (e.g. stats "big number" + "label" share a tile) don't cry wolf, while two
      // text blocks actually colliding (almost always >0.35in²) still get caught.
      const minFor = (a, b) => isText(a) && isText(b) ? Math.max(overlapMin, 0.35) : Math.max(overlapMin, 0.5);
      for (let i = 0; i < check.length; i++) {
        for (let j = i + 1; j < check.length; j++) {
          const a = check[i], b = check[j];
          const pairConflict = (isContainer(a) && isContainer(b)) || (isText(a) && isText(b));
          if (!pairConflict) continue;
          const k = intersect(a, b);
          if (!k || area(k) < minFor(a, b)) continue;
          if (containment(a, b) >= 0.7 || containment(b, a) >= 0.7) continue;
          issues.push({
            slide: n, severity: 'error', kind: 'overlap',
            msg: `元素重叠（${labelOf(a)} ↔ ${labelOf(b)}：重叠 ${area(k).toFixed(2)} 平方英寸）`,
            box: k, a, b,
          });
        }
      }
    }

    // (c) whitespace (grid coverage) -----------------------------------------
    // Coverage is computed for every slide (reported in perSlide); the whitespace ISSUE is only
    // raised for non-exempt content slides — covers/closings are intentionally airy.
    const cov = coverage(boxes.filter((b) => fillLayers.includes(b.layer)));
    perSlide.push({ slide: n, coverage: cov.ratio, largestEmpty: cov.largest });
    if (!exempt[n] && cov.largest && cov.largest.area / SLIDE_AREA >= wsAreaRatio &&
        Math.min(cov.largest.w, cov.largest.h) >= wsMinDim) {
      issues.push({
        slide: n, severity: 'warn', kind: 'whitespace',
        msg: `大片留白（约 ${(cov.largest.area / SLIDE_AREA * 100).toFixed(0)}%，位于 x${cov.largest.x.toFixed(1)} y${cov.largest.y.toFixed(1)}，${cov.largest.w.toFixed(1)}"×${cov.largest.h.toFixed(1)}"）`,
        box: cov.largest,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, issues, errors, perSlide };
}

// Grid coverage: overlay a fine grid, mark cells covered by any fill box, then find the
// LARGEST EMPTY RECTANGLE — the biggest axis-aligned rectangle that contains no filled cell.
// (A connected-component bounding box overestimates badly, because the thin empty "moat"
// around content — margins, gaps, the band between header and cards — is all one component
// whose bounding box is the whole slide.) Maximal-empty-rect via 2D prefix sums, O(rows²·cols).
function coverage(fillBoxes, cell) {
  cell = cell || 0.25;
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const filled = (cx, cy) => fillBoxes.some((b) => cx >= b.x - 1e-9 && cx <= b.x + b.w + 1e-9 && cy >= b.y - 1e-9 && cy <= b.y + b.h + 1e-9);

  // filled[r][c] = 1 if that cell's center is covered by a fill box; plus a 2D prefix sum.
  const grid = new Uint8Array(cols * rows);
  let filledCount = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (filled(c * cell + cell / 2, r * cell + cell / 2)) { grid[r * cols + c] = 1; filledCount++; }
  }
  const pref = new Int32Array((rows + 1) * (cols + 1)); // pref[(r+1)*(cols+1)+(c+1)]
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    pref[(r + 1) * (cols + 1) + (c + 1)] = grid[r * cols + c]
      + pref[r * (cols + 1) + (c + 1)] + pref[(r + 1) * (cols + 1) + c] - pref[r * (cols + 1) + c];
  }
  // filled cells in rows [r1..r2] × cols [c1..c2]
  const rectFilled = (r1, r2, c1, c2) =>
    pref[(r2 + 1) * (cols + 1) + (c2 + 1)] - pref[r1 * (cols + 1) + (c2 + 1)]
    - pref[(r2 + 1) * (cols + 1) + c1] + pref[r1 * (cols + 1) + c1];

  let largest = null;
  for (let r1 = 0; r1 < rows; r1++) {
    for (let r2 = r1; r2 < rows; r2++) {
      // scan columns; a column c is "open" for this row-band if no filled cell in rows r1..r2 at col c.
      // track the longest run of open columns → candidate empty rectangle.
      let run = 0;
      for (let c = 0; c < cols; c++) {
        const open = rectFilled(r1, r2, c, c) === 0;
        if (open) {
          run++;
          const a = run * cell * (r2 - r1 + 1) * cell;
          if (!largest || a > largest.area) {
            largest = { x: (c - run + 1) * cell, y: r1 * cell, w: run * cell, h: (r2 - r1 + 1) * cell };
            largest.area = a;
          }
        } else run = 0;
      }
    }
  }
  return { ratio: filledCount / (cols * rows), largest };
}

function labelOf(b) {
  if (b && b.label) return b.label;
  return b && b.layer ? b.layer : '元素';
}

// Pretty report for logs / REPL.
function report(res) {
  const lines = [];
  if (!res.issues.length) { lines.push('LAYOUT-QA: clean (无溢出/重叠/大片留白)'); return lines.join('\n'); }
  const errs = res.issues.filter((i) => i.severity === 'error');
  const warns = res.issues.filter((i) => i.severity === 'warn');
  lines.push(`LAYOUT-QA: ${errs.length} 个问题，${warns.length} 个警告`);
  for (const i of res.issues) {
    lines.push(`  slide ${i.slide} [${i.kind}] ${i.msg}`);
  }
  return lines.join('\n');
}

module.exports = { analyze, report, coverage, intersect, area, containment, W, H, SLIDE_AREA };
// (LayoutLog + wrapElements are exported at the end of the file — classes are not hoisted.)

// ---------------- geometry capture (the E-recorder) ------------------------
// Wraps the elements-primitive object so every box a renderer places is logged with a
// semantic layer, WITHOUT modifying elements.js or any renderer. Internal sub-calls inside
// composite methods (card→rrect, header→text) use the unwrapped locals, so each visual region
// is logged exactly once at the right semantic level.
//
// Layers: bg | chrome | decor | card | image | text | badge | shape | table
//   - SOLID (overlap-checked): card image text badge shape table
//   - fillLayers (counted for coverage): everything except decor
//   - decor (decorative ovals/bars/dots) and near-full-slide boxes are exempt from overlap

class LayoutLog {
  constructor() { this.cur = 1; this.deck = {}; this.types = {}; }
  setSlide(n) { this.cur = n; if (!this.deck[n]) this.deck[n] = []; }
  setType(n, t) { this.types[n] = t; }
  add(layer, x, y, w, h, label) {
    if (!this.deck[this.cur]) this.deck[this.cur] = [];
    this.deck[this.cur].push({ layer, x, y, w, h, label: label || '' });
  }
}

const W13 = 13.33, H75 = 7.5, M06 = 0.6, CW13 = W13 - 2 * M06;

function wrapElements(E, log) {
  const wrap = {};
  const rec = (layer, xb, yb, wb, hb, label) => log.add(layer, xb, yb, wb, hb, label);
  // simple (s,x,y,w,h,...) primitives
  for (const m of ['rect', 'rrect']) {
    wrap[m] = (s, x, y, w, h, ...a) => { rec('shape', x, y, w, h); return E[m](s, x, y, w, h, ...a); };
  }
  for (const m of ['text', 'fitText', 'fitBullets']) {
    // allow a caller to tag a text box as a different layer via opts._layer (e.g. freeform 'ghost'
    // backdrop glyphs record as 'decor' so they don't trip overlap checks).
    wrap[m] = (s, x, y, w, h, ...a) => {
      const o = a[a.length - 1];
      const layer = (o && typeof o === 'object' && o._layer) || 'text';
      rec(layer, x, y, w, h);
      return E[m](s, x, y, w, h, ...a);
    };
  }
  wrap.bg = (s, color) => { rec('bg', 0, 0, W13, H75, 'background'); return E.bg(s, color); };
  wrap.oval = (s, x, y, d, ...a) => { rec('decor', x, y, d, d); return E.oval(s, x, y, d, ...a); };
  wrap.imageBox = (s, x, y, w, h, ...a) => { rec('image', x, y, w, h); return E.imageBox(s, x, y, w, h, ...a); };
  wrap.card = (s, x, y, w, h, ...a) => { rec('card', x, y, w, h); return E.card(s, x, y, w, h, ...a); };
  wrap.bullets = (...a) => E.bullets(...a);                 // returns runs, places nothing itself
  wrap.SH = (...a) => E.SH(...a);
  wrap.decorate = (...a) => E.decorate(...a);               // decorations: exempt, not logged
  // composite: header/footer draw a title band / footer band — log representative chrome boxes
  wrap.header = (s, ...a) => {
    rec('chrome', M06, 0.4, CW13, 1.85, 'header');
    rec('chrome', M06, 7.02, CW13, 0.42, 'footer');
    return E.header(s, ...a);
  };
  wrap.footer = (s, ...a) => { rec('chrome', M06, 7.02, CW13, 0.42, 'footer'); return E.footer(s, ...a); };
  // async badges
  wrap.numBadge = async (s, x, y, d, ...a) => { rec('badge', x, y, d, d); return E.numBadge(s, x, y, d, ...a); };
  wrap.iconBadge = async (s, x, y, d, ...a) => { rec('badge', x, y, d, d); return E.iconBadge(s, x, y, d, ...a); };
  // future-proof: pass through any primitive not explicitly wrapped above
  for (const k of Object.keys(E)) {
    if (!(k in wrap) && typeof E[k] === 'function') {
      wrap[k] = (...a) => E[k](...a);
    }
  }
  return wrap;
}

module.exports = { analyze, report, coverage, intersect, area, containment, W, H, SLIDE_AREA,
  LayoutLog, wrapElements };
