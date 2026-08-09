// geometry.js — pure geometry engine for the whitespace harness (no deps).
// Canvas is 13.33" × 7.5" (LAYOUT_WIDE). All rects are {x,y,w,h} in inches.

const W = 13.33, H = 7.5;
const SLIDE_AREA = W * H;
// layers that visually fill space (counted as "not blank"). bg/decor excluded.
const FILL_LAYERS = new Set(['card', 'image', 'text', 'badge', 'shape', 'table', 'chart', 'chrome']);

const centerInside = (b, p) => {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h;
};

// Build a filled grid (cell inches) from fill boxes.
function buildGrid(fillBoxes, cell) {
  cell = cell || 0.2;
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const grid = new Uint8Array(cols * rows);
  const filled = (cx, cy) => fillBoxes.some((b) => cx >= b.x - 1e-9 && cx <= b.x + b.w + 1e-9 && cy >= b.y - 1e-9 && cy <= b.y + b.h + 1e-9);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    if (filled(c * cell + cell / 2, r * cell + cell / 2)) grid[r * cols + c] = 1;
  return { grid, cols, rows, cell };
}

// Largest axis-aligned empty rectangle via 2D prefix sums (maximal-empty-rect).
function largestEmptyRect(g) {
  const { grid, cols, rows, cell } = g;
  const pref = new Int32Array((rows + 1) * (cols + 1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    pref[(r + 1) * (cols + 1) + (c + 1)] = grid[r * cols + c] + pref[r * (cols + 1) + (c + 1)] + pref[(r + 1) * (cols + 1) + c] - pref[r * (cols + 1) + c];
  const rectFilled = (r1, r2, c1, c2) => pref[(r2 + 1) * (cols + 1) + (c2 + 1)] - pref[r1 * (cols + 1) + (c2 + 1)] - pref[(r2 + 1) * (cols + 1) + c1] + pref[r1 * (cols + 1) + c1];
  let best = null;
  for (let r1 = 0; r1 < rows; r1++) for (let r2 = r1; r2 < rows; r2++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      if (rectFilled(r1, r2, c, c) === 0) {
        run++;
        const a = run * cell * (r2 - r1 + 1) * cell;
        if (!best || a > best.area) best = { x: (c - run + 1) * cell, y: r1 * cell, w: run * cell, h: (r2 - r1 + 1) * cell, area: a };
      } else run = 0;
    }
  }
  return best;
}

// Iterative top-N non-overlapping empty rectangles (candidate blanks).
function emptyRegions(fillBoxes, opts) {
  opts = opts || {};
  const minArea = opts.minArea != null ? opts.minArea : 0.05 * SLIDE_AREA;
  const minDim = opts.minDim != null ? opts.minDim : 0.9;
  const g = buildGrid(fillBoxes, 0.2);
  const out = [];
  for (let i = 0; i < (opts.maxN || 6); i++) {
    const r = largestEmptyRect(g);
    if (!r || r.area < minArea || Math.min(r.w, r.h) < minDim) break;
    out.push(r);
    const c0 = Math.floor(r.x / g.cell), c1 = Math.ceil((r.x + r.w) / g.cell);
    const r0 = Math.floor(r.y / g.cell), r1 = Math.ceil((r.y + r.h) / g.cell);
    for (let rr = r0; rr < r1 && rr < g.rows; rr++) for (let cc = c0; cc < c1 && cc < g.cols; cc++) g.grid[rr * g.cols + cc] = 1;
  }
  return out;
}

// "thin block" candidates: big panel whose inner content covers little → frame mostly empty inside.
function thinBlocks(boxes) {
  const out = [];
  const panels = boxes.filter((b) => ['card', 'shape'].includes(b.layer) && b.w * b.h >= 4.0);
  for (const p of panels) {
    const inner = boxes.filter((b) => ['text', 'image', 'badge'].includes(b.layer) && centerInside(b, p));
    const innerArea = inner.filter((b) => ['text', 'image'].includes(b.layer)).reduce((s, b) => s + Math.min(b.w * b.h, p.w * p.h), 0);
    const ratio = innerArea / (p.w * p.h);
    if (ratio < 0.25) out.push({ panel: { x: p.x, y: p.y, w: p.w, h: p.h }, ratio });
  }
  return out;
}

const where = (r) => {
  const cy = r.y + r.h / 2, cx = r.x + r.w / 2;
  const v = cy < H / 3 ? '上' : cy < (2 * H) / 3 ? '中' : '下';
  const hz = cx < W / 3 ? '左' : cx < (2 * W) / 3 ? '中' : '右';
  return v + hz;
};

// per-slide candidate blanks, filtering title band / footer / hero (intentionally airy) pages.
function candidatesFor(slide) {
  const isHero = slide.role === 'cover' || slide.role === 'closing' || slide.role === 'divider';
  const fillBoxes = slide.boxes.filter((b) => FILL_LAYERS.has(b.layer));
  const regions = emptyRegions(fillBoxes).filter((r) => {
    if (!isHero && r.y < 2.0 && r.y + r.h <= 2.05) return false; // title band
    if (r.y >= 7.0) return false; // footer strip
    return true;
  });
  return { regions, thin: isHero ? [] : thinBlocks(slide.boxes), isHero };
}

// merge rects whose overlap is substantial (one blank the model drew as 2 boxes → 1).
function mergeOverlapping(rects) {
  const ov = (a, b) => {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    const inter = (x1 - x0) * (y1 - y0), sm = Math.min(a.w * a.h, b.w * b.h);
    return sm > 0 ? inter / sm : 0;
  };
  let arr = rects.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < arr.length && !changed; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (ov(arr[i], arr[j]) >= 0.4) {
          const a = arr[i], b = arr[j];
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
          const sev = (a.severity === 'high' || b.severity === 'high') ? 'high' : (a.severity === 'medium' || b.severity === 'medium' ? 'medium' : 'low');
          const merged = { x, y, w: x2 - x, h: y2 - y, area: (x2 - x) * (y2 - y), severity: sev, reason: a.reason || b.reason || '', kind: a.kind || 'blank' };
          arr = arr.filter((_, k) => k !== i && k !== j).concat(merged);
          changed = true; break;
        }
      }
    }
  }
  return arr;
}

module.exports = { W, H, SLIDE_AREA, FILL_LAYERS, centerInside, buildGrid, largestEmptyRect, emptyRegions, thinBlocks, where, candidatesFor, mergeOverlapping };
