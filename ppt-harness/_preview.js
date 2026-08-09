#!/usr/bin/env node
// _preview.js — render a freeform deck's slides (.spec.json) to PNG via SVG + sharp.
// A lightweight preview that needs NO LibreOffice: each freeform slide's elements → SVG → PNG.
//   node _preview.js <deck.pptx> [outDir]
const fs = require('fs'), path = require('path');
const sharp = require('sharp');
const paletteMod = require('./lib/palette');
const images = require('./lib/images');
const { fixZOrder } = require('./lib/freeform-tools'); // match the renderer's deterministic z-order

const DPI = 96, W = 13.33 * DPI, H = 7.5 * DPI;
const px = (v) => (v || 0) * DPI;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isCJK = (ch) => /[　-鿿＀-￯]/.test(ch);

function col(C, v, fb) {
  if (!v) return fb;
  if (C && C[v]) return C[v];
  const h = String(v).replace('#', '');
  if (/^[0-9A-Fa-f]{6}$/.test(h)) return h;
  return fb;
}

function wrap(text, fsPx, boxWpx) {
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    let line = '', w = 0;
    for (const ch of raw) {
      const cw = isCJK(ch) ? fsPx : fsPx * 0.55;
      if (w + cw > boxWpx && line) { lines.push(line); line = ch; w = cw; }
      else { line += ch; w += cw; }
    }
    lines.push(line);
  }
  return lines;
}

function textSvg(text, x, y, w, h, o, C) {
  const fsPx = o.size || 16;
  const fill = col(C, o.color, C ? C.ink : '102A2E');
  const lines = wrap(text, fsPx, Math.max(20, w - 4));
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start';
  const tx = o.align === 'center' ? x + w / 2 : o.align === 'right' ? x + w : x + 2;
  let startY;
  if (o.valign === 'middle' || o.valign === 'center') startY = y + h / 2 - (lines.length - 1) * fsPx * 1.25 / 2 + fsPx * 0.35;
  else if (o.valign === 'bottom') startY = y + h - (lines.length - 1) * fsPx * 1.25;
  else startY = y + fsPx;
  const tspans = lines.map((ln, i) => `<tspan x="${tx.toFixed(1)}" dy="${i === 0 ? 0 : fsPx * 1.25}">${esc(ln)}</tspan>`).join('');
  const sp = o.spacing ? ` letter-spacing="${o.spacing}"` : '';
  const fw = o.bold ? ' font-weight="700"' : '';
  return `<text x="${tx.toFixed(1)}" y="${startY.toFixed(1)}" font-size="${fsPx}" fill="#${fill}" text-anchor="${anchor}"${fw}${sp}>${tspans}</text>`;
}

function elemSvg(e, C, imgCache) {
  const x = px(e.x), y = px(e.y), w = px(e.w || e.d || 0), h = px(e.h || e.d || 0);
  switch (e.k) {
    case 'ghost': {
      const gtxt = String(e.text != null ? e.text : ''), gsize = e.size || 120;
      if (/\d/.test(gtxt) || gsize > 100) return ''; // match renderer: drop floating-number / oversize ghosts
      const fill = col(C, e.fill || e.color, C ? C.muted : '888888');
      return `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h * 0.72).toFixed(1)}" font-size="${gsize}" fill="#${fill}" fill-opacity="0.10" text-anchor="middle" font-weight="800">${esc(gtxt)}</text>`;
    }
    case 'rect': case 'rrect': {
      const fill = col(C, e.fill, null), op = e.opacity != null ? ` fill-opacity="${e.opacity}"` : '';
      const rx = e.k === 'rrect' ? ` rx="${(Math.min(w, h) * 0.08).toFixed(1)}"` : '';
      return fill ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#${fill}"${op}${rx}/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#${col(C, 'muted', 'cccccc')}" stroke-width="1"${rx}/>`;
    }
    case 'oval': {
      const fill = col(C, e.fill, C ? C.mint : '2DBE9E'), op = e.opacity != null ? ` fill-opacity="${e.opacity}"` : '';
      const d = e.d || Math.max(e.w || 0, e.h || 0);
      return `<circle cx="${(x + d / 2).toFixed(1)}" cy="${(y + d / 2).toFixed(1)}" r="${(d / 2).toFixed(1)}" fill="#${fill}"${op}/>`;
    }
    case 'image': {
      const q = e.q || e.query || e.img, du = imgCache[q];
      if (du) return `<image href="${du}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#${col(C, 'cardTint', 'eef2f7')}" rx="${(Math.min(w, h) * 0.05).toFixed(1)}"/><text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2).toFixed(1)}" font-size="13" fill="#${col(C, 'muted', '999999')}" text-anchor="middle">${esc((q || 'image').slice(0, 26))}</text>`;
    }
    case 'text': case 'fit':
      return textSvg(e.text, x, y, w, h, { size: e.size || e.fontSize || 16, color: e.color, bold: e.bold, align: e.align, valign: e.valign }, C);
    case 'bullets': {
      const fs = e.size || 16, c = col(C, e.color, C ? C.slate : '444444');
      return (e.items || []).map((it, i) =>
        `<circle cx="${(x + 4).toFixed(1)}" cy="${(y + fs * (i + 0.55)).toFixed(1)}" r="2.5" fill="#${col(C, 'mint', '2DBE9E')}"/>`
        + textSvg(it, x + 12, y + fs * i, Math.max(20, w - 12), fs * 1.3, { size: fs, color: e.color, align: 'left' }, C)
      ).join('');
    }
    case 'badge': case 'icon': {
      const dpx = (e.d || 0.6) * DPI, fill = col(C, e.color, C ? C.primary : '157F8B');
      return `<circle cx="${(x + dpx / 2).toFixed(1)}" cy="${(y + dpx / 2).toFixed(1)}" r="${(dpx / 2).toFixed(1)}" fill="#${fill}"/>`
        + (e.text ? textSvg(e.text, x, y, dpx, dpx, { size: dpx * 0.5, color: 'white', bold: true, align: 'center', valign: 'middle' }, C) : '');
    }
    case 'line':
      return `<line x1="${x}" y1="${y}" x2="${px(e.x2 || e.x)}" y2="${px(e.y2 || e.y)}" stroke="#${col(C, e.color, C ? C.mint : '2DBE9E')}" stroke-width="${e.size || 2}"/>`;
    default: return '';
  }
}

function renderSlide(s, C, imgCache) {
  const bg = col(C, s.bg, C ? C.offWhite : 'ffffff');
  const parts = [`<rect width="${W}" height="${H}" fill="#${bg}"/>`];
  if (s.role !== 'cover' && s.role !== 'closing' && (s.title || s.eyebrow)) {
    if (s.eyebrow) parts.push(textSvg(s.eyebrow, px(0.6), px(0.45), px(12.1), px(0.4), { size: 14, color: C.primary, bold: true, align: 'left', spacing: 5 }, C));
    if (s.title) parts.push(textSvg(s.title, px(0.6), px(0.78), px(12.1), px(0.9), { size: 30, color: C.ink, bold: true, align: 'left' }, C));
    if (s.sub) parts.push(textSvg(s.sub, px(0.6), px(1.62), px(12.1), px(0.5), { size: 16, color: C.muted, align: 'left' }, C));
  }
  for (const e of fixZOrder(s.elements || [])) parts.push(elemSvg(e, C, imgCache));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="PingFang SC, Heiti SC, Microsoft YaHei, sans-serif">${parts.join('')}</svg>`;
}

async function fetchImages(slides) {
  const qs = new Set();
  slides.forEach((s) => (s.elements || []).forEach((e) => { if (e.k === 'image') { const q = e.q || e.query || e.img; if (q) qs.add(q); } }));
  const cache = {}; images._used = new Set();
  await Promise.all([...qs].map(async (q) => {
    try { const r = await images.getImage(q, { orientation: 'landscape', used: images._used }); if (r && r.buf) cache[q] = images.dataUrl(r.buf); } catch (e) {}
  }));
  return cache;
}

async function main() {
  const deck = process.argv[2]; const outDir = process.argv[3] || path.join(path.dirname(deck), 'preview_svg');
  fs.mkdirSync(outDir, { recursive: true });
  const spec = JSON.parse(fs.readFileSync(deck + '.spec.json', 'utf8'));
  const C = spec.palette ? paletteMod.coerce(spec.palette) : paletteMod.get(spec.theme || 'healthcare');
  const slides = (spec.slides || []).filter((s) => s.t === 'free');
  console.log('rendering ' + slides.length + ' free slides; theme=' + (spec.theme || '(custom)'));
  const imgCache = await fetchImages(slides);
  console.log('fetched ' + Object.keys(imgCache).length + '/' + Object.keys(imgCache).length + ' images');
  const base = path.basename(deck, '.pptx');
  for (let i = 0; i < slides.length; i++) {
    const out = path.join(outDir, base + '-' + String(i + 1).padStart(2, '0') + '.png');
    await sharp(Buffer.from(renderSlide(slides[i], C, imgCache))).png().toFile(out);
    process.stdout.write('  ' + (i + 1) + '');
  }
  console.log('\nDONE -> ' + outDir);
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
