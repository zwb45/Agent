// harness.js — declarative PPT builder. Typography (fonts + sizes) is centralized in lib/typography.js
// and threaded through every renderer, so the LLM can re-decide it via build({ typography }).
// Fuller text + per-card images + beautified data + minimal cover/closing + resilient write.

const pptxgen = require('pptxgenjs');
const palette = require('./lib/palette');
const typography = require('./lib/typography');
const styleMod = require('./lib/style');
const Efactory = require('./lib/elements');
const images = require('./lib/images');
const qa = require('./lib/qa');
const layoutQA = require('./lib/layout-qa');
const freeform = require('./lib/freeform');
const fs = require('fs');
const path = require('path');

const W = 13.33, H = 7.5, M = 0.6, CW = W - 2 * M;
const RENDERERS = {};

async function fetchImage(img, query, C, opts) {
  if (!img) return null;
  try {
    let r = await img.getImage(query, { orientation: 'landscape', used: img._used || null });
    if (!r) r = await images.svgHero(C, Object.assign({ seed: query, w: 1600, h: 900 }, opts || {}));
    return images.dataUrl(r.buf);
  } catch (e) { return null; }
}
async function fetchImageBuf(img, query) {
  if (!img || !query) return null;
  try { const r = await img.getImage(query, { orientation: 'landscape', used: img._used || null }); return r ? r.buf : null; }
  catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeResilient(p, out) {
  const dir = path.dirname(path.resolve(out));
  fs.mkdirSync(dir, { recursive: true });
  const buf = await p.write({ outputType: 'nodebuffer' });
  const ext = path.extname(out);
  const base = out.slice(0, out.length - ext.length);
  const tmp = path.join(dir, '.' + path.basename(base) + '.tmp-' + process.pid + ext);
  fs.writeFileSync(tmp, buf);
  const tryRename = (from, to) => { try { fs.renameSync(from, to); return true; } catch (e) { return false; } };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryRename(tmp, out)) {
      if (attempt > 0) console.log('  [write] target was busy, succeeded on retry ' + (attempt + 1));
      return { file: out, fallback: false };
    }
    await sleep(500);
  }
  for (let n = 2; n <= 12; n++) {
    const cand = base + '-' + n + ext;
    if (!fs.existsSync(cand)) { try { fs.renameSync(tmp, cand); return { file: cand, fallback: true }; } catch (e) { /* next */ } }
  }
  const ts = base + '.' + Date.now() + ext;
  try { fs.renameSync(tmp, ts); return { file: ts, fallback: true }; }
  catch (e) { return { file: tmp, fallback: true }; }
}

// Render optional header `lead` (intro under title) + bottom `note` (source). Returns content band {y0,bot,ch}.
function leadAndTop(E, C, T, s, spec) {
  if (spec.lead) E.text(s, M, 2.12, CW, 0.52, spec.lead, { fontSize: T.sizes.lead, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0, valign: 'top' });
  const y0 = spec.lead ? 2.76 : 2.15;
  const bot = spec.note ? 6.6 : 6.92;
  if (spec.note) E.text(s, M, 6.72, CW, 0.3, spec.note, { fontSize: T.sizes.note, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
  return { y0, bot, ch: bot - y0 };
}

// Grid of cards, EACH with its own relevant image (thumbnail + title + desc). Text auto-fits via T ranges.
async function imageCards(E, C, T, s, img, cards, y0, ch, o) {
  const cols = o.cols, gap = 0.3;
  const rows = Math.ceil(cards.length / cols);
  const cardW = (CW - gap * (cols - 1)) / cols, cardH = (ch - gap * (rows - 1)) / rows;
  const imgH = Math.min(cardH * (o.imgRatio || 0.48), o.imgMax || 1.1);
  const wPx = Math.round(cardW * 150), hPx = Math.round(imgH * 150);
  const queries = cards.map((c) => c.img || c.title || c.topic || '');
  const bufs = await Promise.all(queries.map((q) => fetchImageBuf(img, q)));
  const align = o.align || 'left';
  for (let k = 0; k < cards.length; k++) {
    const r = Math.floor(k / cols), c = k % cols, x = M + c * (cardW + gap), y = y0 + r * (cardH + gap);
    const col = cards[k].color || C.accents[k % C.accents.length];
    E.card(s, x, y, cardW, cardH);
    if (bufs[k]) {
      const cropped = await images.cover(bufs[k], wPx, hPx);
      E.imageBox(s, x, y, cardW, imgH, images.dataUrl(cropped), { plain: true });
    } else {
      E.rrect(s, x, y, cardW, imgH, { fill: C.cardTint, radius: 0.08 });
      if (cards[k].icon) await E.iconBadge(s, x + cardW / 2 - 0.3, y + imgH / 2 - 0.3, 0.6, cards[k].icon, col, C.white);
    }
    E.fitText(s, x + 0.22, y + imgH + 0.12, cardW - 0.44, 0.5, cards[k].title, { minSize: o.titleMin, maxSize: o.titleMax, bold: true, color: C.ink, align, fontFace: T.headingFont });
    E.fitText(s, x + 0.22, y + imgH + 0.64, cardW - 0.44, cardH - imgH - 0.76, cards[k].desc, { minSize: o.descMin, maxSize: o.descMax, color: C.muted, align, valign: 'top', fontFace: T.bodyFont });
  }
}

// ---------------- slide renderers ----------------

RENDERERS.cover = async ({ E, C, T, S, s, spec, img }) => {
  const q = (typeof spec.img === 'string' ? spec.img : spec.topic) || 'technology abstract';
  const du = spec.img === false ? null : await fetchImage(img, q, C);
  if (S.cover === 'split') {
    const splitX = 7.2;
    E.rect(s, 0, 0, splitX, H, { fill: C.dark });
    if (du) E.imageBox(s, splitX, 0, W - splitX, H, du); else E.rect(s, splitX, 0, W - splitX, H, { fill: C.primary });
    E.text(s, 0.8, 2.4, splitX - 1.4, 0.5, spec.eyebrow || '', { fontSize: T.sizes.coverEyebrow, bold: true, color: C.mintLt, fontFace: T.headingFont, charSpacing: 6, margin: 0 });
    E.text(s, 0.75, 2.9, splitX - 1.2, 2.0, spec.title, { fontSize: T.sizes.coverTitle, bold: true, color: C.white, fontFace: T.headingFont, margin: 0 });
    if (spec.subtitle) E.text(s, 0.8, 4.9, splitX - 1.4, 0.8, spec.subtitle, { fontSize: T.sizes.coverSub, color: C.mintLt, fontFace: T.bodyFont, margin: 0, valign: 'top' });
    if (spec.meta) E.text(s, 0.8, 6.8, splitX - 1.4, 0.35, spec.meta, { fontSize: T.sizes.coverMeta, color: C.mintLt, fontFace: T.bodyFont, margin: 0 });
    return;
  }
  if (S.cover === 'solid') {
    E.bg(s, C.dark);
    E.decorate(s, 'cover');
    const center = S.header === 'center';
    const cx = center ? 0 : 1.0, cw = center ? W : 11.4, al = center ? 'center' : 'left';
    E.text(s, cx, center ? 2.2 : 2.5, cw, 0.5, spec.eyebrow || '', { fontSize: T.sizes.coverEyebrow, bold: true, color: C.mintLt, align: al, fontFace: T.headingFont, charSpacing: 6, margin: 0 });
    E.text(s, cx, center ? 2.8 : 3.0, cw, 1.9, spec.title, { fontSize: T.sizes.coverTitle + 2, bold: true, color: C.white, align: al, fontFace: T.headingFont, margin: 0 });
    if (spec.subtitle) E.text(s, cx, center ? 4.9 : 5.05, cw, 0.7, spec.subtitle, { fontSize: T.sizes.coverSub, color: C.mintLt, align: al, fontFace: T.bodyFont, margin: 0 });
    if (spec.meta) E.text(s, cx, 6.9, cw, 0.35, spec.meta, { fontSize: T.sizes.coverMeta, color: C.mintLt, align: al, fontFace: T.bodyFont, margin: 0 });
    return;
  }
  // photo (classic / tech)
  E.bg(s, C.dark);
  if (du) { E.imageBox(s, 0, 0, W, H, du); E.rect(s, 0, 0, W, H, { fill: C.dark, transparency: spec.overlay != null ? spec.overlay : 42 }); }
  E.decorate(s, 'cover');
  E.text(s, 1.05, 2.65, 10, 0.5, spec.eyebrow || '', { fontSize: T.sizes.coverEyebrow, bold: true, color: C.mintLt, fontFace: T.headingFont, charSpacing: 6, margin: 0 });
  E.text(s, 1.0, 3.15, 11.4, 1.9, spec.title, { fontSize: T.sizes.coverTitle, bold: true, color: C.white, fontFace: T.headingFont, margin: 0 });
  if (spec.subtitle) E.text(s, 1.05, 5.05, 9.5, 0.6, spec.subtitle, { fontSize: T.sizes.coverSub, color: C.mintLt, fontFace: T.bodyFont, margin: 0 });
  E.text(s, 1.05, 6.9, 8, 0.35, spec.meta || '', { fontSize: T.sizes.coverMeta, color: C.mintLt, fontFace: T.bodyFont, margin: 0 });
};

RENDERERS.divider = async ({ E, C, T, s, spec, img }) => {
  const q = (typeof spec.img === 'string' ? spec.img : spec.topic) || 'abstract';
  const du = await fetchImage(img, q, C);
  if (du) { E.imageBox(s, 0, 0, W, H, du); E.rect(s, 0, 0, W, H, { fill: C.dark, transparency: spec.overlay != null ? spec.overlay : 45 }); }
  else E.bg(s, C.dark);
  E.oval(s, 9.8, -2.0, 5.6, C.mint, 75);
  E.text(s, 0.9, 2.5, 11, 0.5, spec.eyebrow || '', { fontSize: T.sizes.coverEyebrow, bold: true, color: C.mintLt, fontFace: T.headingFont, charSpacing: 5, margin: 0 });
  E.text(s, 0.85, 3.0, 11.6, 1.8, spec.title, { fontSize: T.sizes.coverTitle, bold: true, color: C.white, fontFace: T.headingFont, margin: 0 });
  if (spec.subtitle) E.text(s, 0.9, 4.7, 10, 0.9, spec.subtitle, { fontSize: T.sizes.coverSub, color: C.mintLt, fontFace: T.bodyFont, margin: 0, valign: 'top' });
  if (spec.points) spec.points.slice(0, 3).forEach((p, k) => {
    E.oval(s, 0.95 + k * 4.0, 6.15, 0.16, C.mint);
    E.text(s, 1.2 + k * 4.0, 6.05, 3.7, 0.5, p, { fontSize: T.sizes.body, color: C.white, fontFace: T.bodyFont, margin: 0, valign: 'middle' });
  });
};

RENDERERS.agenda = async ({ E, C, T, s, spec, total, i }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow || '导览', spec.title || '内容导航', total, spec.sub);
  const { y0, ch } = leadAndTop(E, C, T, s, spec);
  const items = (spec.items || []).slice(0, 10), cw = 5.865, gy = 0.22;
  const rows = Math.max(1, Math.ceil(items.length / 2));
  const cardH = (ch - gy * (rows - 1)) / rows; // scale to the real number of rows (was hardcoded /3)
  for (let k = 0; k < items.length; k++) {
    const r = Math.floor(k / 2), c = k % 2, x = M + c * (cw + 0.4), y = y0 + r * (cardH + gy);
    E.card(s, x, y, cw, cardH);
    const col = items[k].color || C.accents[k % C.accents.length];
    const d = Math.min(0.74, cardH * 0.56);
    await E.numBadge(s, x + 0.28, y + (cardH - d) / 2, d, items[k].n || String(k + 1).padStart(2, '0'), col, 18);
    E.fitText(s, x + 1.25, y + 0.14, cw - 1.5, 0.46, items[k].title, { minSize: T.sizes.agendaTitleMin, maxSize: T.sizes.agendaTitleMax, bold: true, color: C.ink, fontFace: T.headingFont });
    E.fitText(s, x + 1.25, y + 0.6, cw - 1.5, cardH - 0.7, items[k].desc, { minSize: T.sizes.agendaDescMin, maxSize: T.sizes.agendaDescMax, color: C.muted, fontFace: T.bodyFont, valign: 'top' });
  }
};

RENDERERS.stats = async ({ E, C, T, s, spec, total, i }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const { y0, bot } = leadAndTop(E, C, T, s, spec);
  const sts = spec.stats || [], sw = (CW - (sts.length - 1) * 0.3) / sts.length, stH = 1.72;
  sts.forEach((st, k) => {
    const x = M + k * (sw + 0.3), col = st.color || C.accents[k % C.accents.length];
    E.rrect(s, x, y0, sw, stH, { fill: C.cardTint, radius: 0.12 });
    E.text(s, x + 0.22, y0 + 0.2, sw - 0.44, 0.78, st.big, { fontSize: T.sizes.statBig, bold: true, color: col, fontFace: T.headingFont, margin: 0 });
    E.text(s, x + 0.22, y0 + 1.0, sw - 0.44, 0.4, st.label, { fontSize: T.sizes.statLabel, bold: true, color: C.ink, fontFace: T.headingFont, margin: 0 });
    if (st.sub) E.text(s, x + 0.22, y0 + 1.36, sw - 0.44, 0.32, st.sub, { fontSize: T.sizes.statSub, color: C.muted, fontFace: T.bodyFont, margin: 0 });
  });
  const colY = y0 + stH + 0.28, colH = bot - colY, cw = (CW - 0.4) / 2;
  (spec.cols || []).forEach((col, k) => {
    const x = M + k * (cw + 0.4);
    E.card(s, x, colY, cw, colH);
    E.text(s, x + 0.35, colY + 0.2, cw - 0.7, 0.42, col.title, { fontSize: T.sizes.statLabel + 2, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0 });
    E.fitBullets(s, x + 0.35, colY + 0.7, cw - 0.7, colH - 0.85, col.bullets, { fontFace: T.bodyFont, color: C.slate, minSize: T.sizes.bullets, maxSize: T.sizes.bullets + 5 });
  });
};
RENDERERS.iconGrid = async ({ E, C, T, s, spec, total, i, img }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const { y0, ch } = leadAndTop(E, C, T, s, spec);
  const cards = spec.cards || [];
  if (img && spec.images !== false) return await imageCards(E, C, T, s, img, cards, y0, ch, { cols: 3, align: 'left', titleMin: T.sizes.cardTitleMin, titleMax: T.sizes.cardTitleMax, descMin: T.sizes.cardDescMin, descMax: T.sizes.cardDescMax });
  const cols = 3, gap = 0.3, rows = Math.ceil(cards.length / cols);
  const cardW = (CW - gap * (cols - 1)) / cols, cardH = (ch - gap * (rows - 1)) / rows;
  for (let k = 0; k < cards.length; k++) {
    const r = Math.floor(k / cols), c = k % cols, x = M + c * (cardW + gap), y = y0 + r * (cardH + gap);
    const col = cards[k].color || C.accents[k % C.accents.length];
    E.card(s, x, y, cardW, cardH);
    await E.iconBadge(s, x + cardW / 2 - 0.42, y + 0.26, 0.84, cards[k].icon, col, C.white);
    E.fitText(s, x + 0.2, y + 1.26, cardW - 0.4, 0.46, cards[k].title, { minSize: T.sizes.cardTitleMin, maxSize: T.sizes.cardTitleMax, bold: true, color: C.ink, align: 'center', fontFace: T.headingFont });
    E.fitText(s, x + 0.2, y + 1.74, cardW - 0.4, cardH - 1.82, cards[k].desc, { minSize: T.sizes.cardDescMin, maxSize: T.sizes.cardDescMax, color: C.muted, align: 'center', fontFace: T.bodyFont, valign: 'top' });
  }
};

RENDERERS.chart = async ({ p, E, C, T, s, spec, total, i }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const lw = 5.1;
  if (spec.lead) E.text(s, M, 2.18, lw, 1.05, spec.lead, { fontSize: T.sizes.body, color: C.slate, fontFace: T.bodyFont, paraSpaceAfter: 4, valign: 'top', margin: 0 });
  if (spec.bullets) E.fitBullets(s, M, 3.35, lw, 1.5, spec.bullets, { fontFace: T.bodyFont, color: C.slate, minSize: T.sizes.bullets, maxSize: T.sizes.bullets + 4 });
  if (spec.stat) {
    E.rrect(s, M, 5.05, lw, 1.5, { fill: C.dark, radius: 0.12 });
    E.text(s, M + 0.3, 5.18, 2.2, 1.0, spec.stat.big, { fontSize: T.sizes.chartStatBig, bold: true, color: C.mint, fontFace: T.headingFont, valign: 'middle', margin: 0 });
    E.text(s, M + 2.5, 5.18, lw - 2.8, 1.2, spec.stat.desc, { fontSize: T.sizes.body, color: C.white, fontFace: T.bodyFont, valign: 'middle', margin: 0 });
  }
  if (spec.note) E.text(s, M, 6.72, CW, 0.3, spec.note, { fontSize: T.sizes.note, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
  const cx = M + lw + 0.4, cwid = CW - lw - 0.4, c = spec.chart || {};
  const fmtCode = c.dataLabelFmt || (c.suffix ? ('0"' + c.suffix + '"') : '0');
  s.addChart(p.ChartType.bar, [{ name: c.seriesName || 'value', labels: c.cats, values: c.vals }], {
    x: cx, y: 2.15, w: cwid, h: 4.45,
    showTitle: true, title: c.title, titleColor: C.ink, titleFontFace: T.headingFont, titleFontSize: 13, titleBold: true,
    showLegend: false, barDir: 'col', barGapWidthPct: c.gap || 50,
    showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: c.color || C.ink, dataLabelFontSize: 12, dataLabelFontFace: T.headingFont, dataLabelBold: true, dataLabelFormatCode: fmtCode,
    chartColors: [c.color || C.mint],
    catAxisLabelColor: C.ink, catAxisLabelFontSize: 12, catAxisLabelFontFace: T.bodyFont, catAxisLabelBold: true, catAxisLineShow: false,
    catAxisTitle: c.xTitle || '', catAxisTitleColor: C.muted, catAxisTitleFontSize: 10, catAxisTitleFontFace: T.bodyFont,
    valAxisMinVal: c.min || 0, valAxisMaxVal: c.max, valAxisMajorUnit: c.step,
    valAxisLabelColor: C.muted, valAxisLabelFontSize: 9, valAxisLabelFontFace: T.bodyFont, valAxisLineShow: false,
    valAxisTitle: c.yTitle || '', valAxisTitleColor: C.muted, valAxisTitleFontSize: 10, valAxisTitleFontFace: T.bodyFont, valAxisTitleRotate: 270,
    valGridLine: { color: C.cardTint, size: 1 }, catGridLine: { style: 'none' },
  });
};

RENDERERS.flow = async ({ E, C, T, s, spec, total, i }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const sts = spec.stats || [], sw = (CW - (sts.length - 1) * 0.3) / Math.max(sts.length, 1);
  sts.forEach((st, k) => {
    const x = M + k * (sw + 0.3), col = st.color || C.accents[k % C.accents.length];
    E.rrect(s, x, 2.15, sw, 1.32, { fill: C.cardTint, radius: 0.12 });
    E.text(s, x + 0.3, 2.3, sw - 0.6, 1.0, st.big, { fontSize: T.sizes.flowBig, bold: true, color: col, fontFace: T.headingFont, valign: 'middle', margin: 0 });
    const bigw = st.big.length > 4 ? 3.0 : 2.4;
    E.text(s, x + (st.big.length > 4 ? 2.7 : 2.2), 2.3, sw - bigw, 1.0, st.label, { fontSize: T.sizes.statLabel, color: C.slate, fontFace: T.bodyFont, valign: 'middle', margin: 0 });
  });
  if (spec.heading) E.text(s, M, 3.72, CW, 0.4, spec.heading, { fontSize: T.sizes.statLabel + 2, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0 });
  const steps = spec.steps || [], n = steps.length, gap = 0.5, bw = (CW - gap * (n - 1)) / n, fy = 4.25, fh = 2.25;
  for (let k = 0; k < n; k++) {
    const x = M + k * (bw + gap), col = steps[k].color || C.accents[k % C.accents.length];
    E.card(s, x, fy, bw, fh);
    await E.iconBadge(s, x + bw / 2 - 0.3, fy + 0.26, 0.6, steps[k].icon, col, C.white);
    E.fitText(s, x + 0.15, fy + 1.0, bw - 0.3, 0.38, steps[k].title, { minSize: T.sizes.cardTitleMin, maxSize: T.sizes.cardTitleMax, bold: true, color: C.ink, align: 'center', fontFace: T.headingFont });
    E.fitText(s, x + 0.15, fy + 1.4, bw - 0.3, 0.78, steps[k].desc, { minSize: T.sizes.cardDescMin - 1, maxSize: T.sizes.cardDescMax, color: C.muted, align: 'center', fontFace: T.bodyFont, valign: 'top' });
    if (k < n - 1) E.text(s, x + bw - 0.02, fy + fh / 2 - 0.35, gap + 0.04, 0.7, '→', { fontSize: 26, bold: true, color: C.mint, align: 'center', valign: 'middle', fontFace: T.headingFont, margin: 0 });
  }
  if (spec.note) E.text(s, M, 6.72, CW, 0.3, spec.note, { fontSize: T.sizes.note, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
};

RENDERERS.pipeline = async ({ E, C, T, s, spec, total, i }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const sts = spec.stats || [], sw = (CW - (sts.length - 1) * 0.3) / Math.max(sts.length, 1);
  sts.forEach((st, k) => {
    const x = M + k * (sw + 0.3), col = st.color || C.accents[k % C.accents.length];
    E.rrect(s, x, 2.15, sw, 1.32, { fill: C.cardTint, radius: 0.12 });
    E.text(s, x + 0.3, 2.3, sw - 0.6, 1.0, st.big, { fontSize: T.sizes.pipeBig, bold: true, color: col, fontFace: T.headingFont, valign: 'middle', margin: 0 });
    E.text(s, x + 2.7, 2.3, sw - 3.0, 1.0, st.label, { fontSize: T.sizes.statLabel, color: C.slate, fontFace: T.bodyFont, valign: 'middle', margin: 0 });
  });
  if (spec.heading) E.text(s, M, 3.72, CW, 0.4, spec.heading, { fontSize: T.sizes.statLabel + 2, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0 });
  const trackY = 5.1;
  E.rrect(s, M + 0.5, trackY - 0.04, CW - 1.0, 0.08, { fill: C.mintLt, radius: 0.04 });
  const phases = spec.phases || [], seg = CW / Math.max(phases.length, 1);
  phases.forEach((ph, k) => {
    const cxp = M + seg * k + seg / 2, accent = !!ph.accel;
    const nodeColor = accent ? C.coral : (C.teal || C.primary);
    E.oval(s, cxp - 0.34, trackY - 0.34, 0.68, nodeColor);
    E.text(s, cxp - 0.34, trackY - 0.34, 0.68, 0.68, String(k + 1), { fontSize: T.sizes.statLabel + 2, bold: true, color: C.white, align: 'center', valign: 'middle', fontFace: T.headingFont, margin: 0 });
    if (ph.accel) E.text(s, cxp - seg / 2 + 0.1, trackY - 0.95, seg - 0.2, 0.3, 'AI 加速', { fontSize: T.sizes.note, bold: true, color: C.coral, align: 'center', fontFace: T.headingFont, margin: 0 });
    E.fitText(s, cxp - seg / 2 + 0.1, trackY + 0.5, seg - 0.2, 0.4, ph.title, { minSize: T.sizes.cardTitleMin, maxSize: T.sizes.cardTitleMax, bold: true, color: C.ink, align: 'center', fontFace: T.headingFont });
    E.fitText(s, cxp - seg / 2 + 0.1, trackY + 0.92, seg - 0.2, 0.7, ph.desc, { minSize: T.sizes.cardDescMin - 1, maxSize: T.sizes.cardDescMax, color: C.muted, align: 'center', fontFace: T.bodyFont, valign: 'top' });
  });
  if (spec.note) E.text(s, M, 6.72, CW, 0.3, spec.note, { fontSize: T.sizes.note, italic: true, color: C.muted, fontFace: T.bodyFont, margin: 0 });
};
RENDERERS.twoCol = async ({ E, C, T, s, spec, total, i, img }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const { y0, ch } = leadAndTop(E, C, T, s, spec);
  const lw = spec.img ? 6.6 : (CW - 0.4) / 2;
  E.card(s, M, y0, lw, ch);
  E.text(s, M + 0.4, y0 + 0.22, lw - 0.8, 0.45, spec.left.title, { fontSize: T.sizes.statLabel + 4, bold: true, color: C.dark, fontFace: T.headingFont, margin: 0 });
  if (spec.left.lead) E.text(s, M + 0.4, y0 + 0.78, lw - 0.8, 0.9, spec.left.lead, { fontSize: T.sizes.body, color: C.slate, fontFace: T.bodyFont, paraSpaceAfter: 4, valign: 'top', margin: 0 });
  const btY = spec.left.lead ? y0 + 1.8 : y0 + 0.8;
  E.fitBullets(s, M + 0.4, btY, lw - 0.8, y0 + ch - btY - 0.2, spec.left.bullets, { fontFace: T.bodyFont, color: C.slate, minSize: T.sizes.bullets, maxSize: T.sizes.bullets + 5 });
  const rx = M + lw + 0.4, rw = CW - lw - 0.4;
  if (spec.img) {
    const du = await fetchImage(img, spec.img, C);
    const ih = ch * 0.62;
    if (du) E.imageBox(s, rx, y0, rw, ih, du, { rounding: 0.08 });
    else E.rrect(s, rx, y0, rw, ih, { fill: C.cardTint, radius: 0.08 });
    if (spec.caption) E.text(s, rx, y0 + ih + 0.16, rw, ch - ih - 0.2, spec.caption, { fontSize: T.sizes.body - 1, color: C.slate, fontFace: T.bodyFont, valign: 'top', margin: 0 });
  } else {
    const mini = spec.right || [], mh = (ch - (mini.length - 1) * 0.22) / Math.max(mini.length, 1);
    mini.forEach((m, k) => {
      const yy = y0 + k * (mh + 0.22), col = m.color || C.accents[k % C.accents.length];
      E.rrect(s, rx, yy, rw, mh, { fill: C.cardTint, radius: 0.12 });
      E.text(s, rx + 0.3, yy + 0.12, rw - 0.5, 0.6, m.big, { fontSize: T.sizes.statBig - 8, bold: true, color: col, fontFace: T.headingFont, margin: 0 });
      E.text(s, rx + 0.3, yy + 0.7, rw - 0.5, mh - 0.8, m.label, { fontSize: T.sizes.statLabel, color: C.slate, fontFace: T.bodyFont, margin: 0 });
    });
  }
};

RENDERERS.quadrant = async ({ E, C, T, s, spec, total, i, img }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const { y0, ch } = leadAndTop(E, C, T, s, spec);
  const cards = spec.cards || [];
  if (img && spec.images !== false) return await imageCards(E, C, T, s, img, cards, y0, ch, { cols: 2, align: 'left', imgRatio: 0.42, titleMin: T.sizes.quadTitleMin, titleMax: T.sizes.quadTitleMax, descMin: T.sizes.quadDescMin, descMax: T.sizes.quadDescMax });
  const cw = (CW - 0.33) / 2, cardH = (ch - 0.3) / 2;
  for (let k = 0; k < cards.length; k++) {
    const r = Math.floor(k / 2), c = k % 2, x = M + c * (cw + 0.33), y = y0 + r * (cardH + 0.3);
    const col = cards[k].color || C.accents[k % C.accents.length];
    E.card(s, x, y, cw, cardH);
    const d = Math.min(0.78, cardH * 0.42);
    await E.iconBadge(s, x + 0.32, y + (cardH - d) / 2, d, cards[k].icon, col, C.white);
    E.fitText(s, x + d + 1.0, y + 0.3, cw - d - 1.25, 0.5, cards[k].title, { minSize: T.sizes.quadTitleMin, maxSize: T.sizes.quadTitleMax, bold: true, color: C.ink, fontFace: T.headingFont });
    E.fitText(s, x + d + 1.0, y + 0.82, cw - d - 1.25, cardH - 0.92, cards[k].desc, { minSize: T.sizes.quadDescMin, maxSize: T.sizes.quadDescMax, color: C.slate, fontFace: T.bodyFont, valign: 'top' });
  }
};

RENDERERS.future = async ({ E, C, T, s, spec, total, i, img }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const { y0, ch } = leadAndTop(E, C, T, s, spec);
  const cards = spec.cards || [];
  if (img && spec.images !== false) return await imageCards(E, C, T, s, img, cards, y0, ch, { cols: 3, align: 'left', imgRatio: 0.34, imgMax: 1.35, titleMin: T.sizes.futureTitleMin, titleMax: T.sizes.futureTitleMax, descMin: T.sizes.futureDescMin, descMax: T.sizes.futureDescMax });
  const cw = (CW - 0.6) / 3;
  for (let k = 0; k < cards.length; k++) {
    const x = M + k * (cw + 0.3), col = cards[k].color || C.accents[k % C.accents.length];
    E.card(s, x, y0, cw, ch);
    E.oval(s, x + cw - 1.7, y0 - 0.45, 1.7, col, 84);
    if (cards[k].icon) await E.iconBadge(s, x + 0.4, y0 + 0.45, 0.92, cards[k].icon, col, C.white);
    E.fitText(s, x + 0.4, y0 + 1.7, cw - 0.8, 0.6, cards[k].title, { minSize: T.sizes.futureTitleMin, maxSize: T.sizes.futureTitleMax, bold: true, color: C.ink, fontFace: T.headingFont });
    E.fitText(s, x + 0.4, y0 + 2.4, cw - 0.8, ch - 2.6, cards[k].desc, { minSize: T.sizes.futureDescMin, maxSize: T.sizes.futureDescMax, color: C.slate, fontFace: T.bodyFont, valign: 'top', paraSpaceAfter: 4 });
  }
};

RENDERERS.table = async ({ E, C, T, s, spec, total, i, img }) => {
  E.bg(s, C.offWhite); E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);
  const { y0, ch } = leadAndTop(E, C, T, s, spec);
  const hasImg = !!spec.img;
  const imgDu = hasImg ? await fetchImage(img, spec.img, C) : null;
  const contentW = hasImg ? 8.4 : CW;
  if (hasImg) {
    const imgX = M + contentW + 0.3, imgW = CW - contentW - 0.3;
    if (imgDu) E.imageBox(s, imgX, y0, imgW, ch, imgDu, { rounding: 0.05 });
    else E.rrect(s, imgX, y0, imgW, ch, { fill: C.cardTint, radius: 0.05 });
  }
  const cols = spec.columns || [], rows = spec.rows || [], tableRows = [];
  tableRows.push(cols.map((cc) => ({ text: cc.header, options: { bold: true, color: C.white, fill: { color: C.primary }, align: cc.align || 'left', valign: 'middle' } })));
  rows.forEach((rw, ri) => {
    const bg = ri % 2 ? C.cardTint : C.white;
    tableRows.push(cols.map((cc, ci) => {
      let val = (rw && rw[cc.key] != null) ? rw[cc.key] : (Array.isArray(rw) ? rw[ci] : '');
      const opts = { fill: { color: bg }, align: cc.align || 'left', valign: 'middle', color: C.ink };
      if (val && typeof val === 'object') { if (val.bold) opts.bold = true; if (val.color) opts.color = val.color; val = val.text; }
      return { text: String(val), options: opts };
    }));
  });
  const colW = cols.map((cc) => (cc.w ? cc.w * contentW : contentW / cols.length));
  s.addTable(tableRows, { x: M, y: y0, w: contentW, colW, rowH: 0.46, fontSize: T.sizes.body, fontFace: T.bodyFont, color: C.ink, border: { type: 'solid', color: C.cardTint, pt: 1 }, align: 'left', valign: 'middle', autoPage: false });
};

RENDERERS.closing = async ({ E, C, T, S, s, spec }) => {
  // Light closing (user pref: avoid dark backgrounds). Subtle accent decor on a light field.
  E.bg(s, C.offWhite);
  E.oval(s, 10.2, -1.8, 4.6, C.mint, 84);
  E.oval(s, -0.6, 5.2, 3.0, C.mintLt, 80);
  const center = S.header === 'center';
  const cx = center ? 0 : 1.05, cw = center ? W : 11.4, al = center ? 'center' : 'left';
  if (!center) E.rect(s, 1.05, 2.78, 1.2, 0.06, { fill: C.primary });
  E.text(s, cx, center ? 2.7 : 2.95, cw, 0.5, spec.eyebrow || '结语', { fontSize: T.sizes.closingEyebrow, bold: true, color: C.primary, align: al, fontFace: T.headingFont, charSpacing: 6, margin: 0 });
  E.text(s, center ? 0 : 1.0, center ? 3.2 : 3.4, cw, 1.8, spec.title, { fontSize: T.sizes.closingTitle + (center ? 2 : 0), bold: true, color: C.dark, align: al, fontFace: T.headingFont, margin: 0 });
  if (spec.sub) E.text(s, cx, 5.15, cw, 0.6, spec.sub, { fontSize: T.sizes.closingSub, color: C.slate, align: al, fontFace: T.bodyFont, margin: 0 });
  E.text(s, cx, 6.5, cw, 0.5, spec.thanks || '谢谢观看 · Thank You', { fontSize: T.sizes.closingSub + 2, bold: true, color: C.primary, align: al, fontFace: T.headingFont, margin: 0 });
  if (spec.note) E.text(s, cx, 7.0, cw, 0.3, spec.note, { fontSize: T.sizes.note, color: C.slate, align: al, fontFace: T.bodyFont, margin: 0 });
};

// ---------------- entry point ----------------

// Freeform renderer: the LLM authors the entire layout as placed elements; the harness only
// renders + validates. See lib/freeform.js. This is the "tools, not decisions" path.
RENDERERS.free = freeform.renderFree;

async function build(opts) {
  opts = opts || {};
  const theme = opts.theme || 'healthcare';
  const slides = opts.slides || [];
  const out = opts.out || 'output/deck.pptx';
  const useImages = opts.useImages !== false;
  const runQA = opts.runQA !== false;
  const renderPreview = opts.renderPreview !== false;

  const C = opts.palette ? palette.coerce(opts.palette)
    : (typeof theme === 'string' ? palette.get(theme) : palette.coerce(theme));
  const T = typography.make(opts.typography);
  let S = styleMod.resolveStyle(opts.style || 'classic');
  // the LLM may author individual design axes instead of (or on top of) a named style
  for (const axis of ['header', 'cover', 'card', 'decorate']) if (opts[axis]) S[axis] = opts[axis];
  if ((opts.header || opts.cover || opts.card || opts.decorate) && !opts.style) S.name = 'custom';
  if (opts.footerLabel) C._footerLabel = opts.footerLabel;
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  p.title = opts.title || 'PPT Harness Deck';
  const Eraw = Efactory.make(p, C, T, S);
  // Geometry capture: wrap E so every placed box is logged per-slide for layout QA
  // (bounds/overlap/whitespace). Renderers receive the wrapped E; internal sub-calls are not
  // double-logged. The freeform renderer's elements flow through the same primitives.
  const layoutLog = new layoutQA.LayoutLog();
  const E = layoutQA.wrapElements(Eraw, layoutLog);
  const total = slides.length;
  const img = useImages ? images : null;
  if (img) img._used = new Set(); // per-deck image-URL registry → no repeated images
  if (opts.style || opts.header || opts.cover || opts.card || opts.decorate || S.name !== 'classic') {
    console.log('STYLE:  ' + S.name + '  (header:' + S.header + ' cover:' + S.cover + ' card:' + S.card + ' decorate:' + S.decorate + ')' + (opts.palette ? ' +custom palette' : ''));
  }

  for (let k = 0; k < slides.length; k++) {
    const spec = slides[k];
    const fn = RENDERERS[spec.t];
    if (!fn) { console.warn('  [harness] unknown slide type:', spec.t); continue; }
    const s = p.addSlide();
    if (spec.notes) s.addNotes(spec.notes);
    layoutLog.setSlide(k + 1);
    layoutLog.setType(k + 1, spec.t);
    // Capture the two element types that bypass the E primitives (charts + tables) so layout QA
    // sees their footprint and doesn't false-positive "whitespace" over a chart/table.
    const _chart = s.addChart && s.addChart.bind(s);
    if (_chart) s.addChart = (type, data, opts) => { if (opts) layoutLog.add('chart', opts.x, opts.y, opts.w, opts.h, 'chart'); return _chart(type, data, opts); };
    const _table = s.addTable && s.addTable.bind(s);
    if (_table) s.addTable = (rows, opts) => { if (opts) layoutLog.add('table', opts.x, opts.y, opts.w, (opts.rowH || 0.46) * (rows || []).length, 'table'); return _table(rows, opts); };
    await fn({ p, E, C, T, S, s, spec, total, i: k + 1, img });
    console.log('  [harness] slide ' + (k + 1) + '/' + total + ': ' + spec.t);
  }
  if (img) delete img._used;

  // Hero slides (cover/divider/closing, incl. freeform slides with those roles) are intentionally
  // airy/full-bleed — exempt them from the overlap + whitespace checks (bounds still enforced).
  const exempt = {};
  slides.forEach((spec, k) => {
    if (['cover', 'divider', 'closing'].includes(spec.t) ||
        (spec.t === 'free' && ['cover', 'closing', 'divider'].includes(spec.role))) exempt[k + 1] = true;
  });

  const { file: outFile, fallback } = await writeResilient(p, out);
  if (fallback) console.log('WROTE ' + outFile + '   [!] 目标 ' + path.basename(out) + ' 被占用（可能正用 Office 打开），已改用备用文件名；关闭旧文件后即可覆盖原名]');
  else console.log('WROTE ' + outFile);

  // Persist the slide spec next to the deck so apply_edits can modify it later.
  // (ids are auto-assigned so edits can target slides stably.)
  if (opts.saveSpec !== false) {
    try {
      const seen = new Set(); let n = 0;
      const slidesCopy = slides.map((s) => {
        const c = Object.assign({}, s);
        if (!c.id || seen.has(c.id)) { n++; c.id = 's' + n; }
        seen.add(c.id);
        return c;
      });
      const spec = {
        version: 1,
        deck: opts.title || 'PPT Harness Deck',
        theme: typeof theme === 'string' ? theme : '(custom)',
        palette: opts.palette || null,
        style: S.name !== 'classic' ? S.name : (opts.style || null),
        header: S.header, cover: S.cover, card: S.card, decorate: S.decorate,
        footerLabel: opts.footerLabel,
        typography: opts.typography || null,
        slides: slidesCopy,
      };
      fs.writeFileSync(outFile + '.spec.json', JSON.stringify(spec, null, 2));
      console.log('SPEC:   ' + outFile + '.spec.json');
    } catch (e) { console.log('SPEC:   not saved (' + e.message + ')'); }
  }

  if (runQA) {
    const v = qa.validate(outFile);
    console.log(v.ok ? 'VALIDATE: PASS' : 'VALIDATE: ISSUES');
    if (!v.ok) console.log(v.output);
    const lint = qa.lintContent(outFile);
    if (lint.length) {
      console.log('LINT: ⚠ design-meta / self-referential text found (remove before shipping):');
      lint.forEach((l) => console.log('  slide ' + l.slide + '  [' + l.hits + ']  ' + l.snippet));
    } else {
      console.log('LINT: clean (no design-meta text)');
    }
  }

  // Layout QA: bounds / overlap / whitespace over the captured geometry.
  const layout = layoutQA.analyze(layoutLog.deck, { exempt });
  console.log(layoutQA.report(layout));
  try { fs.writeFileSync(outFile + '.layout.json', JSON.stringify({ ok: layout.ok, issues: layout.issues, perSlide: layout.perSlide, boxes: layoutLog.deck }, null, 2)); }
  catch (e) { /* non-fatal */ }
  if (typeof opts.onLayout === 'function') opts.onLayout(layout, layoutLog.deck);

  if (renderPreview) {
    const r = qa.renderAll(outFile, path.join(path.dirname(path.resolve(outFile)), 'preview'));
    if (r.error) console.log('RENDER: ' + r.error);
    else console.log('RENDER: ' + r.pngs.length + ' slide PNGs -> ' + path.dirname(r.pngs[0]));
  }
  return outFile;
}

module.exports = { build, RENDERERS, palette, typography, images, qa, W, H, M, CW };
