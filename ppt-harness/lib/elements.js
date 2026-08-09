// elements.js — pptxgenjs layout primitives, bound to a pptx instance + palette.
// No accent stripes / no title underlines (per skill guidance). Circle motif for badges.

const icons = require('./icons');
const typography = require('./typography');
const styleMod = require('./style');

// Estimate wrapped line count for mixed CJK/latin text at a font size, given box width (inches).
// Tuned conservative: real CJK advance (~1.04em), real internal margins subtracted — so the
// auto-fit rarely overflows the box in LibreOffice/PowerPoint rendering.
function estLines(text, fsPt, boxWIn) {
  const fsIn = fsPt / 72;
  let lines = 0;
  for (const seg of String(text).split('\n')) {
    let w = 0;
    for (const ch of seg) {
      if (/[　-鿿＀-￯‐-‧]/.test(ch)) w += fsIn * 1.04;   // CJK / fullwidth / dashes
      else if (ch === ' ' || ch === '\t') w += fsIn * 0.30;
      else w += fsIn * 0.56;                              // latin / digit / punct
    }
    lines += Math.max(1, Math.ceil(w / Math.max(0.4, boxWIn - 0.18)));  // minus L+R internal margin
  }
  return lines;
}

// Estimated rendered height (inches) of a bullet list at a font size, with paragraph spacing.
function estBulletHeight(items, fsPt, boxWIn, lh, spaceAfterPt) {
  let h = 0;
  for (const it of items) h += estLines(it, fsPt, boxWIn) * (fsPt / 72) * lh;
  h += Math.max(0, (items.length - 1)) * (spaceAfterPt / 72);
  return h;
}

function make(pptx, C, T, S) {
  T = T || typography.make();
  S = S || styleMod.resolveStyle('classic');
  const SH = () => ({ type: 'outer', color: '1A2B2E', blur: 7, offset: 2.5, angle: 90, opacity: 0.16 });
  const CW = 13.33 - 2 * 0.6;

  function bg(s, color) { s.background = { color }; }

  function rrect(s, x, y, w, h, o = {}) {
    s.addShape(pptx.ShapeType.roundRect, {
      x, y, w, h, rectRadius: o.radius != null ? o.radius : 0.12,
      fill: { color: o.fill || C.white, transparency: o.transparency || 0 },
      line: o.lineColor ? { color: o.lineColor, width: o.lineWidth || 1 } : { type: 'none' },
      shadow: o.shadow ? SH() : undefined,
      rotate: o.rotate != null ? o.rotate : undefined,
    });
  }

  function rect(s, x, y, w, h, o = {}) {
    s.addShape(pptx.ShapeType.rect, {
      x, y, w, h,
      fill: { color: o.fill || C.white, transparency: o.transparency || 0 },
      line: o.lineColor ? { color: o.lineColor, width: o.lineWidth || 1 } : { type: 'none' },
      shadow: o.shadow ? SH() : undefined,
      rotate: o.rotate != null ? o.rotate : undefined,
    });
  }

  function oval(s, x, y, d, color, transparency, rotate) {
    s.addShape(pptx.ShapeType.ellipse, {
      x, y, w: d, h: d, fill: { color, transparency: transparency || 0 }, line: { type: 'none' },
      rotate: rotate != null ? rotate : undefined,
    });
  }

  function text(s, x, y, w, h, str, o = {}) {
    s.addText(str, Object.assign({
      x, y, w, h, fontFace: T.bodyFont, color: C.slate, fontSize: 13,
      align: 'left', valign: 'top', margin: 0.05,
    }, o, { rotate: o.rotate != null ? o.rotate : undefined }));
    return s;
  }

  // Auto-fit: pick the largest font (within [minSize,maxSize]) that fills the box without overflowing,
  // using a realistic line-height and a safety margin so it matches the box in real rendering.
  // Default valign is 'middle' (single-line titles/numbers sit centered); pass valign:'top' for multi-line body.
  function fitText(s, x, y, w, h, str, o = {}) {
    const min = o.minSize || 11, max = o.maxSize || 16, lh = o.lineHeight || 1.3;
    let best = min;
    for (let fs = min; fs <= max; fs += 0.5) {
      if (estLines(str, fs, w) * (fs / 72) * lh <= h * 0.92) best = fs; else break;
    }
    s.addText(String(str), {
      x, y, w, h, fontSize: best,
      fontFace: o.fontFace || T.bodyFont, color: o.color || C.slate,
      bold: !!o.bold, italic: !!o.italic, align: o.align || 'left',
      valign: o.valign || 'middle', margin: o.margin != null ? o.margin : 0.05,
      charSpacing: o.charSpacing, paraSpaceAfter: o.paraSpaceAfter,
      rotate: o.rotate != null ? o.rotate : undefined,
    });
    return best;
  }

  function bullets(arr, base = {}) {
    return arr.map((t) => ({
      text: t,
      options: Object.assign({
        bullet: { code: '2022', indent: 14 }, color: C.slate, fontSize: 13, fontFace: 'Calibri',
        breakLine: true, paraSpaceAfter: 8, paraSpaceBefore: 0,
      }, base),
    }));
  }

  // Auto-fit a bullet list to fill its box: pick the largest font (within [min,max]) that fits,
  // then — if there's still lots of room — grow the paragraph spacing so the bullets spread to fill.
  function fitBullets(s, x, y, w, h, items, o = {}) {
    items = items || [];
    const min = o.minSize || 12, max = o.maxSize || 18, lh = o.lineHeight || 1.3;
    const baseSpace = o.paraSpaceAfter != null ? o.paraSpaceAfter : 8;
    let best = min;
    for (let fs = min; fs <= max; fs += 0.5) {
      if (estBulletHeight(items, fs, w, lh, baseSpace) <= h * 0.95) best = fs; else break;
    }
    let space = baseSpace;
    const blockH = estBulletHeight(items, best, w, lh, baseSpace);
    if (items.length > 1 && blockH < h * 0.85) {
      const leftover = h * 0.95 - blockH;
      space = Math.min(40, baseSpace + (leftover * 72) / (items.length - 1));
    }
    s.addText(bullets(items, {
      fontFace: o.fontFace || T.bodyFont, color: o.color || C.slate, fontSize: best, paraSpaceAfter: space,
    }), { x, y, w, h, valign: o.valign || 'top', margin: o.margin != null ? o.margin : 0.05 });
    return best;
  }

  // header: page title band. Treatment follows the deck's style.header.
  function header(s, idx, eyebrow, title, total, sub) {
    const M = 0.6, pillW = 1.95;
    if (S.header === 'bar') {
      text(s, M, 0.5, CW, 0.3, eyebrow || '', { fontSize: T.sizes.eyebrow, bold: true, color: C.primary, fontFace: T.headingFont, charSpacing: 3, margin: 0 });
      text(s, M, 0.82, CW, 0.72, title, { fontSize: T.sizes.slideTitle, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0, charSpacing: 0.3 });
      rect(s, M, 1.6, 1.3, 0.07, { fill: C.primary });                       // accent bar under title
      if (sub) text(s, M, 1.78, CW, 0.34, sub, { fontSize: T.sizes.sub, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
    } else if (S.header === 'center') {
      text(s, 0, 0.5, 13.33, 0.3, eyebrow || '', { fontSize: T.sizes.eyebrow, bold: true, color: C.primary, align: 'center', fontFace: T.headingFont, charSpacing: 4, margin: 0 });
      text(s, 0, 0.86, 13.33, 0.8, title, { fontSize: T.sizes.slideTitle + 2, bold: true, color: C.dark, align: 'center', fontFace: T.headingFont, margin: 0 });
      rect(s, 13.33 / 2 - 0.6, 1.74, 1.2, 0.05, { fill: C.mint });            // centered rule
      if (sub) text(s, 0, 1.86, 13.33, 0.34, sub, { fontSize: T.sizes.sub, italic: true, color: C.muted, align: 'center', fontFace: T.bodyFont, margin: 0 });
    } else { // pill (classic)
      rrect(s, M, 0.5, pillW, 0.44, { fill: C.mint, radius: 0.22 });
      text(s, M, 0.5, pillW, 0.44, eyebrow || '', { fontSize: T.sizes.eyebrow, bold: true, color: C.dark, align: 'center', valign: 'middle', fontFace: T.headingFont, margin: 0, charSpacing: 0.5 });
      text(s, M, 1.0, CW, 0.72, title, { fontSize: T.sizes.slideTitle, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0, charSpacing: 0.5 });
      if (sub) text(s, M, 1.72, CW, 0.34, sub, { fontSize: T.sizes.sub, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
    }
    footer(s, idx, total);
  }

  // A content card, styled per S.card. Pass {fill?} to override the fill (e.g. tinted stat tiles).
  function card(s, x, y, w, h, o) {
    o = o || {};
    if (S.card === 'flat') return rrect(s, x, y, w, h, { fill: o.fill || C.cardTint, radius: o.radius || 0.12, shadow: false });
    if (S.card === 'line') return rrect(s, x, y, w, h, { fill: o.fill || C.white, radius: o.radius || 0.06, lineColor: C.mintLt, lineWidth: 1.25, shadow: false });
    return rrect(s, x, y, w, h, { fill: o.fill || C.white, radius: o.radius || 0.1, shadow: true }); // shadow (classic/tech)
  }

  // Decorative motif for cover/closing scenes, per S.decorate.
  function decorate(s, scene) {
    if (S.decorate === 'none') return;
    const W = 13.33, H = 7.5;
    if (S.decorate === 'bars') {
      const cols = [C.mint, C.coral, C.amber];
      for (let i = 0; i < 3; i++) rect(s, W - 1.2 - i * 0.32, 0, 0.16, H, { fill: cols[i % cols.length], transparency: 38 });
      return;
    }
    if (S.decorate === 'dots') {
      for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) oval(s, 11.0 + c * 0.26, 0.4 + r * 0.26, 0.07, C.mintLt, 0);
      return;
    }
    // ovals (classic/tech) — only on dark scenes (cover/closing) where they read well
    if (scene === 'cover') { oval(s, 9.8, -2.0, 5.6, C.mint, 74); oval(s, 1.0, 1.55, 0.3, C.coral, 0); }
    else if (scene === 'closing') { oval(s, 8.9, -2.0, 6.2, C.mint, 80); oval(s, 10.8, 3.6, 3.6, C.teal || C.primary, 66); oval(s, 1.0, 2.5, 0.3, C.coral, 0); }
  }

  function footer(s, idx, total) {
    const M = 0.6;
    text(s, M, 7.12, 5, 0.3, C._footerLabel || 'PPT Harness', { fontSize: 9, color: C.muted, margin: 0 });
    text(s, 13.33 - 2.6, 7.12, 2.0, 0.3, `${String(idx).padStart(2, '0')} / ${total}`, { fontSize: 9, color: C.muted, align: 'right', fontFace: 'Arial', margin: 0 });
  }

  // numbered circle badge
  async function numBadge(s, x, y, d, num, color, fs) {
    oval(s, x, y, d, color);
    text(s, x, y, d, d, String(num), { fontSize: fs || 15, bold: true, color: C.white, align: 'center', valign: 'middle', fontFace: 'Arial', margin: 0 });
  }

  // icon badge: colored circle with a react-icon centered. spec e.g. 'lu/LuStethoscope'.
  async function iconBadge(s, x, y, d, spec, bgColor, iconColor) {
    oval(s, x, y, d, bgColor);
    if (!spec) return false;
    const du = await icons.dataUrl(spec, { color: iconColor || C.white, size: Math.round(d * 0.5) });
    if (!du) { // icon missing: fall back to a dot
      oval(s, x + d * 0.42, y + d * 0.42, d * 0.16, iconColor || C.white);
      return false;
    }
    const pad = d * 0.25;
    s.addImage({ data: du, x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad });
    return true;
  }

  // image placed into a box. Default: cover-fit (crop, no distortion). o.plain: place exact (image already pre-cropped to the box ratio).
  function imageBox(s, x, y, w, h, dataUrl, o = {}) {
    if (!dataUrl) return false;
    const img = {
      data: dataUrl, x, y, w, h,
      rounding: o.rounding ? Math.round((o.rounding) * 100000) / 100000 : undefined,
      transparency: o.transparency || 0,
      rotate: o.rotate != null ? o.rotate : undefined,
    };
    if (!o.plain) img.sizing = { type: 'cover', w, h };
    s.addImage(img);
    return true;
  }

  return { bg, rrect, rect, oval, text, fitText, bullets, fitBullets, header, footer, numBadge, iconBadge, imageBox, card, decorate, SH };
}

module.exports = { make };
