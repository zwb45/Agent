// lib/freeform.js — the "harness provides tools, not decisions" rendering path.
//
// A freeform slide is { t:'free', bg?, elements:[ {k, x, y, w, h, ...} ...], note? }.
// The LLM decides the entire composition — where every element goes, how big, what layer.
// The harness only (a) renders each element via the same primitives the typed renderers use,
// (b) auto-fits text into the boxes the LLM drew (fit / bullets kinds), and (c) lets layout-qa
// validate the result. No layout decisions live here — that's the point: infinite visual
// variety instead of the same stamped template.
//
// Element kinds:  rect · rrect · oval · text · fit · bullets · image · icon · badge · line
//   - numbers are inches on the 13.33 × 7.5 canvas (margin ~0.6")
//   - colors accept a palette key (dark/primary/mint/mintLt/coral/amber/violet/teal/ink/slate/
//     muted/offWhite/cardTint/white) OR a 6-digit hex, with or without '#'

const images = require('./images');
const icons = require('./icons');
const color = require('./color');
const { sanitizeFreeElements, fixZOrder, estLines, TOOLBOX } = require('./freeform-tools'); // T: registry + z-order repair

// resolve a color value (palette key | hex | #hex) to a 6-digit hex against the deck palette C
function col(C, v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'number') return fallback;
  const s = String(v).trim().replace(/^#/, '');
  if (C && C[v] != null) return C[v];        // palette key (dark, primary, mint, …)
  if (/^[0-9A-Fa-f]{6}$/.test(s)) return s;  // raw hex
  return fallback;
}
function num(v, fallback) { const n = parseFloat(v); return isFinite(n) ? n : fallback; }

// Strip design-meta / self-referential phrases the LLM sometimes leaks into copy (mirrors the
// qa.js lint list) so they never reach the rendered slide.
const META_LITERAL = ['这一页', '本页', '该页', '这页', '图文并茂', '文图并茂', '本页配图', '每页配图', '配图'];
const META_RX = /每[^。\n]{0,10}图/g;
function cleanText(t) {
  if (t == null) return t;
  let s = String(t);
  for (const w of META_LITERAL) s = s.split(w).join('');
  s = s.replace(META_RX, '');
  return s.replace(/\s{2,}/g, ' ').replace(/[：:]\s*[，。、]/g, '：').trim();
}

async function fetchImg(img, C, q) {
  if (!q) return null;
  // direct data URL or http(s) URL → hand to pptxgenjs as-is
  if (typeof q === 'string' && /^data:image\//.test(q)) return q;
  if (typeof q === 'string' && /^https?:\/\//.test(q)) {
    try {
      const used = img && img._used;
      const r = await images.getImage(q, { used }); // url-as-query won't match providers → null
      if (r) { if (used && r.url) used.add(r.url); return images.dataUrl(r.buf); }
    } catch (e) { /* fall through */ }
    return q; // let pptxgenjs fetch the raw URL
  }
  try {
    let r = img ? await img.getImage(q, { orientation: 'landscape', used: img._used || null }) : null;
    if (!r) r = await images.svgHero(C, { seed: q, w: 1600, h: 900 });
    return r ? images.dataUrl(r.buf) : null;
  } catch (e) { return null; }
}

// Uniform title band drawn at the top of content freeform slides — eyebrow + title + sub + an
// accent rule + a footer (page n/total). Mirrors the typed renderers' header so the whole deck
// reads as one system. No-op for cover/closing (they have their own treatment).
function drawTitleBand(ctx) {
  const { E, C, T, s, spec, i, total } = ctx;
  if (!spec.title) return;
  if (spec.role === 'cover' || spec.role === 'closing') return;
  const M = 0.6, CW = 13.33 - 2 * M;
  if (spec.eyebrow) E.text(s, M, 0.5, 10, 0.3, spec.eyebrow, { fontSize: T.sizes.eyebrow, bold: true, color: C.primary, fontFace: T.headingFont, charSpacing: 3, margin: 0 });
  E.text(s, M, 0.84, CW, 0.8, spec.title, { fontSize: T.sizes.slideTitle, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0, charSpacing: 0.3 });
  E.rect(s, M, 1.66, 1.3, 0.06, { fill: C.primary });
  if (spec.sub) E.text(s, M, 1.78, CW, 0.34, spec.sub, { fontSize: T.sizes.sub, italic: true, color: C.slate, fontFace: T.bodyFont, margin: 0 });
  // footer (consistent with typed decks)
  E.text(s, M, 7.12, 5, 0.3, C._footerLabel || spec.footerLabel || '', { fontSize: 9, color: C.muted, margin: 0 });
  E.text(s, 13.33 - 2.6, 7.12, 2.0, 0.3, String(i || '').padStart(2, '0') + ' / ' + (total || ''), { fontSize: 9, color: C.muted, align: 'right', fontFace: T.bodyFont, margin: 0 });
}

/**
 * Render a freeform slide. `ctx` is the same context every renderer receives.
 */
async function renderFree(ctx) {
  const { E, C, T, S, s, spec, img, p, i, total } = ctx;
  // T (tool registry): validate the LLM's element vocabulary and clamp coords into the canvas before
  // rendering — malformed elements are reported and dropped instead of silently mis-rendered.
  const { kept, errors } = sanitizeFreeElements(spec.elements);
  if (errors.length) console.warn('  [freeform] dropped ' + errors.length + ' invalid element(s): ' + errors.map((e) => e.k + '(' + e.msg + ')').join('; '));
  // Deterministic z-order repair: decor → opaque panels → content, so a filled box can never cover
  // the image/text placed on it (fixes "image covered by rect" / "rect covers the numbers").
  const elts = fixZOrder(kept);
  // content boxes, for the ghost-overlap check below
  const contentBoxes = elts.filter((e) => ['text', 'fit', 'bullets', 'image', 'icon', 'badge'].includes(e.k) && e.x != null && e.w > 0)
    .map((e) => ({ x: num(e.x, 0), y: num(e.y, 0), w: num(e.w, 4), h: num(e.h, 1) }));

  // Consistent title band at the top of every content page (cover/closing exempt). The composer
  // sets title/eyebrow/sub as FIELDS and places elements only in the content area below — so every
  // page shares one title treatment instead of each slide inventing its own.
  drawTitleBand(ctx);

  // background: solid color (palette key | hex) or { img, overlay }
  if (spec.bg != null) {
    if (typeof spec.bg === 'object' && spec.bg.img) {
      const du = await fetchImg(img, C, spec.bg.img);
      if (du) { E.imageBox(s, 0, 0, 13.33, 7.5, du); if (spec.bg.overlay != null) E.rect(s, 0, 0, 13.33, 7.5, { fill: col(C, spec.bg.overlayColor, C.dark), transparency: spec.bg.overlay }); }
      else E.bg(s, col(C, spec.bg.color, C.dark));
    } else {
      E.bg(s, col(C, spec.bg, C.offWhite));
    }
  }

  // Contrast guard: track solid-fill panels in z-order (array order) so each text element can find
  // its effective background and we override low-contrast text colors — text is never invisible.
  const slideBgHex = (typeof spec.bg === 'object') ? null : col(C, spec.bg, C.offWhite);
  const panels = [];
  const bgFor = (x, y) => { let bg = slideBgHex; for (const p of panels) if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) bg = p.fill; return bg; };
  const textColor = (el, fallback) => {
    const cx = num(el.x, 0) + num(el.w, 4) / 2, cy = num(el.y, 0) + num(el.h, 1) / 2;
    const base = col(C, el.color, fallback), bg = bgFor(cx, cy);
    return bg ? color.readableOn(base, bg, 4.5) : base;
  };

  for (const el of elts) {
    if (!el || el.k == null) continue;
    try {
      switch (el.k) {
        case 'rect': {
          const fill = col(C, el.fill, C.white);
          E.rect(s, num(el.x, 0), num(el.y, 0), num(el.w, 1), num(el.h, 1), {
            fill, transparency: num(el.opacity, 0),
            lineColor: el.line ? col(C, el.line.color || el.line, C.mint) : undefined,
            lineWidth: el.line ? num(el.line.width, 1.25) : undefined,
            shadow: !!el.shadow, rotate: el.rotate != null ? num(el.rotate, 0) : undefined,
          });
          if (!el.opacity) panels.push({ fill, x: num(el.x, 0), y: num(el.y, 0), w: num(el.w, 1), h: num(el.h, 1) });
          break;
        }
        case 'rrect': {
          const fill = col(C, el.fill, C.white);
          E.rrect(s, num(el.x, 0), num(el.y, 0), num(el.w, 1), num(el.h, 1), {
            fill, radius: num(el.radius, 0.1), transparency: num(el.opacity, 0),
            lineColor: el.line ? col(C, el.line.color || el.line, C.mintLt) : undefined,
            lineWidth: el.line ? num(el.line.width, 1.25) : undefined,
            shadow: el.shadow != null ? !!el.shadow : true, rotate: el.rotate != null ? num(el.rotate, 0) : undefined,
          });
          if (!el.opacity) panels.push({ fill, x: num(el.x, 0), y: num(el.y, 0), w: num(el.w, 1), h: num(el.h, 1) });
          break;
        }
        case 'oval': {
          const fill = col(C, el.fill, C.mint), d = num(el.d, num(el.w, 0.6));
          E.oval(s, num(el.x, 0), num(el.y, 0), d, fill, num(el.opacity, 0), el.rotate != null ? num(el.rotate, 0) : undefined);
          break;
        }
        case 'ghost': {
          const gtxt = String(el.text != null ? el.text : '');
          const gsize = num(el.size, 120), gx = num(el.x, 0), gy = num(el.y, 0), gw = num(el.w, 6), gh = num(el.h, 4);
          // drop a ghost that reads as an error: a floating NUMBER (e.g. "98.7%"), or too large, or
          // overlapping readable content — these look like stray junk, not editorial backdrop.
          const overContent = contentBoxes.some((b) => {
            const ix = Math.max(gx, b.x), iy = Math.max(gy, b.y), ix2 = Math.min(gx + gw, b.x + b.w), iy2 = Math.min(gy + gh, b.y + b.h);
            return ix2 > ix && iy2 > iy && (ix2 - ix) * (iy2 - iy) > 0.5;
          });
          if (/\d/.test(gtxt) || gsize > 100 || overContent) break;
          const fill = color.lighten(col(C, el.color, C.mintLt), 0.72);
          const size = Math.min(gsize, 200);
          E.text(s, gx, gy, gw, gh, gtxt,
            { _layer: 'decor', fontSize: size, bold: true, color: fill, align: el.align || 'center', valign: el.valign || 'middle',
              fontFace: T.headingFont, margin: 0, rotate: el.rotate != null ? num(el.rotate, 0) : undefined });
          break;
        }
        case 'tag': {
          // pill label (kicker): rounded chip + centered text
          const fill = col(C, el.fill, C.mint);
          E.rrect(s, num(el.x, 0), num(el.y, 0), num(el.w, 2), num(el.h, 0.36),
            { fill, radius: 0.5, shadow: false, rotate: el.rotate != null ? num(el.rotate, 0) : undefined });
          panels.push({ fill, x: num(el.x, 0), y: num(el.y, 0), w: num(el.w, 2), h: num(el.h, 0.36) });
          E.text(s, num(el.x, 0), num(el.y, 0), num(el.w, 2), num(el.h, 0.36), cleanText(el.text),
            { fontSize: num(el.size, 11), bold: true, color: color.readableOn(col(C, el.color, C.dark), fill, 4.5),
              align: 'center', valign: 'middle', fontFace: T.headingFont, margin: 0 });
          break;
        }
        case 'text': {
          let fs = num(el.size, T.sizes.body);
          const boxW = num(el.w, 4), boxH = num(el.h, 0.5), txt = cleanText(el.text);
          // auto-shrink a fixed-size text box so it never overflows (text stays inside its box/oval)
          while (fs > 9 && estLines(txt, fs, boxW) * (fs / 72 * 1.3) > boxH + 0.05) fs -= 1;
          const o = { fontSize: fs, bold: !!el.bold, italic: !!el.italic,
            color: textColor(el, C.slate), align: el.align || 'left', valign: el.valign || 'top',
            fontFace: el.font || T.bodyFont, margin: el.margin != null ? num(el.margin, 0.05) : 0.05,
            rotate: el.rotate != null ? num(el.rotate, 0) : undefined };
          if (el.spacing != null) o.charSpacing = num(el.spacing, 0);
          E.text(s, num(el.x, 0), num(el.y, 0), boxW, boxH, txt, o);
          break;
        }
        case 'fit':
          E.fitText(s, num(el.x, 0), num(el.y, 0), num(el.w, 4), num(el.h, 1), cleanText(el.text), {
            minSize: num(el.min, 11), maxSize: num(el.max, 18), bold: !!el.bold, italic: !!el.italic,
            color: textColor(el, C.ink), align: el.align || 'left', valign: el.valign || 'middle',
            fontFace: el.font || T.headingFont, lineHeight: num(el.lh, 1.25), rotate: el.rotate != null ? num(el.rotate, 0) : undefined,
          });
          break;
        case 'bullets':
          E.fitBullets(s, num(el.x, 0), num(el.y, 0), num(el.w, 4), num(el.h, 2), (Array.isArray(el.items) ? el.items : []).map(cleanText), {
            minSize: num(el.min, 12), maxSize: num(el.max, 18), color: textColor(el, C.slate),
            fontFace: el.font || T.bodyFont, valign: el.valign || 'top',
          });
          break;
        case 'image': {
          const du = el.url || el.data || await fetchImg(img, C, el.q || el.img);
          if (du) E.imageBox(s, num(el.x, 0), num(el.y, 0), num(el.w, 4), num(el.h, 3), du,
            { plain: !!el.plain, rounding: el.rounding != null ? num(el.rounding, 0) : undefined, transparency: num(el.opacity, 0),
              rotate: el.rotate != null ? num(el.rotate, 0) : undefined });
          break;
        }
        case 'icon': {
          const d = num(el.d, num(el.w, 0.6));
          if (el.bg) await E.iconBadge(s, num(el.x, 0), num(el.y, 0), d, el.spec || 'lu/LuSparkles', col(C, el.bg, C.mint), col(C, el.color, C.white));
          else {
            // raw icon (no badge circle): rasterize + place in a d×d box
            const du = await icons.dataUrl(el.spec || 'lu/LuSparkles', { color: col(C, el.color, C.primary), size: Math.round(d * 150) });
            if (du) s.addImage({ data: du, x: num(el.x, 0), y: num(el.y, 0), w: d, h: d });
          }
          break;
        }
        case 'badge':
          await E.numBadge(s, num(el.x, 0), num(el.y, 0), num(el.d, 0.6), String(el.num != null ? el.num : ''), col(C, el.color, C.mint), num(el.size, 15));
          break;
        case 'line': {
          const x1 = num(el.x1, 0), y1 = num(el.y1, 0), x2 = num(el.x2, 1), y2 = num(el.y2, 1);
          s.addShape(p.ShapeType.line, {
            x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.01, h: Math.abs(y2 - y1) || 0.01,
            line: { color: col(C, el.color, C.mint), width: num(el.w, 1.5) },
            flipH: x1 > x2, flipV: y1 > y2,
          });
          break;
        }
        default:
          break; // unknown kind → skip (layout-qa still sees nothing was placed)
      }
    } catch (e) {
      console.warn('  [freeform] element "' + el.k + '" failed: ' + e.message);
    }
  }
  if (spec.note) E.text(s, 0.6, 7.12, 12.13, 0.3, spec.note, { fontSize: T.sizes.note, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
}

module.exports = { renderFree, col, num, TOOLBOX, sanitizeFreeElements };
