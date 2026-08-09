// icons.js — react-icons -> PNG (via sharp), cached, exposed as base64 dataURLs for pptxgenjs addImage.
// Icon spec format: "pack/Name", e.g. "lu/LuStethoscope", "tb/TbMedicalCrossFilled".
// Packs: lu (lucide), tb (tabler), pi (phosphor), si (simple-icons), fa6 (font-awesome6), hi2 (heroicons2), md (material).

const fs = require('fs');
const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');

const PACK_LOADERS = {
  lu: () => require('react-icons/lu'),
  tb: () => require('react-icons/tb'),
  pi: () => require('react-icons/pi'),
  si: () => require('react-icons/si'),
  fa6: () => require('react-icons/fa6'),
  hi2: () => require('react-icons/hi2'),
  md: () => require('react-icons/md'),
};
const PREFIX = { lu: 'Lu', tb: 'Tb', pi: 'Pi', si: 'Si', fa6: 'Fa', hi2: 'Hi2', md: 'Md' };

const CACHE_DIR = path.join(__dirname, '..', '.cache', 'icons');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const _packs = {};
function loadPack(id) { return _packs[id] || (_packs[id] = PACK_LOADERS[id]()); }

/** Resolve a spec to a react-icons component, or null if not found. */
function resolve(spec) {
  const [pid, name] = String(spec).split('/');
  if (!PACK_LOADERS[pid] || !name) return null;
  const p = loadPack(pid);
  if (p[name]) return p[name];
  const pre = PREFIX[pid];
  const guess = pre + name.charAt(0).toUpperCase() + name.slice(1);
  if (p[guess]) return p[guess];
  // strip a redundant leading prefix the user may have included twice
  const stripped = name.startsWith(pre) ? name : null;
  if (stripped && p[stripped]) return p[stripped];
  return null;
}

/** True if the icon spec resolves. */
function exists(spec) { return !!resolve(spec); }

/** List matching icon names in a pack for a substring query (authoring helper). */
function search(packId, query, limit = 20) {
  if (!PACK_LOADERS[packId]) return [];
  const p = loadPack(packId);
  const q = query.toLowerCase();
  return Object.keys(p).filter((k) => k.toLowerCase().includes(q)).slice(0, limit);
}

/**
 * Rasterize an icon to a PNG Buffer.
 * opts: { color='#202020', size=128, bg? } bg = 'RRGGBB' solid background or {r,g,b,a}; omit for transparent.
 */
async function rasterize(spec, opts = {}) {
  const Comp = resolve(spec);
  if (!Comp) return null;
  const color = opts.color || '202020';
  const size = Number(opts.size) || 128;
  const bg = opts.bg;
  const key = `${spec}|${color}|${size}|${bg ? (typeof bg === 'string' ? bg : JSON.stringify(bg)) : 'none'}`;
  const file = path.join(CACHE_DIR, key.replace(/[^a-z0-9]+/gi, '_') + '.png');
  if (fs.existsSync(file)) return fs.readFileSync(file);

  const el = React.createElement(Comp, { color: '#' + color.replace('#', ''), size });
  let svg = ReactDOMServer.renderToStaticMarkup(el);
  if (!/width=/.test(svg)) svg = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);

  let pipeline = sharp(Buffer.from(svg)).resize(size, size, { fit: 'contain' });
  if (bg) {
    const rgba = typeof bg === 'string'
      ? { r: parseInt(bg.slice(0, 2), 16), g: parseInt(bg.slice(2, 4), 16), b: parseInt(bg.slice(4, 6), 16), alpha: 255 }
      : bg;
    pipeline = pipeline.flatten({ background: rgba });
  }
  const buf = await pipeline.png().toBuffer();
  fs.writeFileSync(file, buf);
  return buf;
}

/** Rasterize and return a pptxgenjs-ready dataURL ('image/png;base64,...'). Null if icon missing. */
async function dataUrl(spec, opts) {
  const buf = await rasterize(spec, opts);
  if (!buf) return null;
  return 'image/png;base64,' + buf.toString('base64');
}

module.exports = { resolve, exists, search, rasterize, dataUrl, PACK_LOADERS };
