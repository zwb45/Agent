// images.js — open-source stock image acquisition (prioritized) + fallbacks.
// Provider chain: Pexels -> Unsplash -> Pixabay -> local assets -> (caller falls back to svgHero).
// All HTTP via curl (more reliable than node fetch on this machine).
// Free keys live in .env: PEXELS_API_KEY, UNSPLASH_ACCESS_KEY, PIXABAY_API_KEY.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

// ---- .env loader (harness root first, then parent) ----
(function loadEnv() {
  for (const dir of [path.join(__dirname, '..'), path.join(__dirname, '..', '..')]) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
})();

const CACHE_DIR = path.join(__dirname, '..', '.cache', 'images');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ppt-harness/0.1';

/** curl wrapper. If outfile omitted, returns stdout (Buffer when binary=true, else utf8 string). null on failure. */
function curl(url, { headers = {}, timeout = 35, binary = false, outfile } = {}) {
  const args = ['-s', '-L', '-m', String(timeout), '-A', UA,
    ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`])];
  if (outfile) { args.push('-o', outfile); } else { args.push('-o', '-'); }
  args.push(url);
  try {
    const out = execFileSync('curl', args, { maxBuffer: 60 * 1024 * 1024, encoding: (outfile || binary) ? undefined : 'utf8' });
    if (outfile) return fs.existsSync(outfile) && fs.statSync(outfile).size > 200 ? fs.readFileSync(outfile) : null;
    return binary ? out : out;
  } catch (e) { return null; }
}

function getJson(url, headers) {
  const raw = curl(url, { headers, timeout: 30 });
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** Resize/normalize a downloaded image buffer to keep the .pptx lean (max 1600px wide). */
async function normalize(buf) {
  try {
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.width > 1600) {
      return await sharp(buf).resize({ width: 1600 }).jpeg({ quality: 85 }).toBuffer();
    }
    return buf;
  } catch (e) { return buf; }
}

function cacheGet(key) { const f = path.join(CACHE_DIR, key); return fs.existsSync(f) ? fs.readFileSync(f) : null; }
function cachePut(key, buf) { fs.writeFileSync(path.join(CACHE_DIR, key), buf); }

// ---------------- providers ----------------

async function pexels(query, { index = 0 } = {}) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const d = getJson(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=12&orientation=landscape`, { Authorization: key });
  const photos = (d && d.photos) || [];
  if (!photos.length) return null;
  const pick = photos[Math.min(index, photos.length - 1)];
  const url = (pick.src && (pick.src.large2x || pick.src.large)) || pick.src && pick.src.original;
  return await downloadUrl(url, 'pexels');
}
pexels.available = () => !!process.env.PEXELS_API_KEY;

async function unsplash(query, { index = 0 } = {}) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  const d = getJson(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=12&orientation=landscape`, { Authorization: `Client-ID ${key}` });
  const results = (d && d.results) || [];
  if (!results.length) return null;
  const pick = results[Math.min(index, results.length - 1)];
  return await downloadUrl(pick.urls && (pick.urls.regular || pick.urls.full), 'unsplash');
}
unsplash.available = () => !!process.env.UNSPLASH_ACCESS_KEY;

async function pixabay(query, { index = 0 } = {}) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  const d = getJson(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=12&safesearch=true`);
  const hits = (d && d.hits) || [];
  if (!hits.length) return null;
  const pick = hits[Math.min(index, hits.length - 1)];
  return await downloadUrl(pick.largeImageURL || pick.webformatURL, 'pixabay');
}
pixabay.available = () => !!process.env.PIXABAY_API_KEY;

async function downloadUrl(url, provider) {
  if (!url) return null;
  const key = provider + '_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.jpg';
  const cached = cacheGet(key);
  if (cached) return { buf: cached, source: provider, url };
  const buf = curl(url, { binary: true, timeout: 40 });
  if (!buf || buf.length < 500) return null;
  const norm = await normalize(buf);
  cachePut(key, norm);
  return { buf: norm, source: provider, url };
}

function local(name) {
  if (!fs.existsSync(ASSETS_DIR)) return null;
  const candidates = fs.readdirSync(ASSETS_DIR).filter((f) => f.toLowerCase().startsWith(name.toLowerCase()));
  if (!candidates.length) return null;
  const buf = fs.readFileSync(path.join(ASSETS_DIR, candidates[0]));
  return { buf, source: 'local', url: candidates[0] };
}

/** Try the open-source provider chain (then local). Returns {buf, source, url} or null.
 *  Pass { used:Set } to dedupe within a deck: results whose url is already in `used` are skipped
 *  (we walk result indices), and a chosen url is added to `used` so it won't recur. */
async function getImage(query, opts = {}) {
  const used = opts.used || null;
  const maxIndex = opts.maxIndex != null ? opts.maxIndex : 11;
  const providers = (opts.providers && opts.providers.length ? opts.providers : ['pexels', 'unsplash', 'pixabay']);
  for (let index = 0; index <= maxIndex; index++) {
    for (const name of providers) {
      const fn = { pexels, unsplash, pixabay }[name];
      if (!fn || !fn.available()) continue;
      try {
        const r = await fn(query, Object.assign({}, opts, { index }));
        if (r && r.buf && (!used || !used.has(r.url))) {
          if (used && r.url) used.add(r.url);
          console.log(`  [images] "${query}" <- ${name}${index ? ' #' + (index + 1) : ''}`);
          return r;
        }
      } catch (e) { /* try next provider/index */ }
    }
    // without dedup we only ever need index 0 (first hit wins, as before)
    if (!used) break;
  }
  const loc = local(query);
  if (loc) { console.log(`  [images] "${query}" <- local`); return loc; }
  console.log(`  [images] "${query}" -> no source (fall back to svg)`);
  return null;
}

// ---------------- programmatic illustration fallback ----------------

/** Build an abstract SVG "hero" scene in a palette, rasterize to PNG. Always succeeds (offline). */
async function svgHero(palette, opts = {}) {
  const w = opts.w || 1344, h = opts.h || 768;
  const c = palette;
  // deterministic-ish node positions from a seed string
  const seed = opts.seed || 'ai';
  const rnd = (i) => { let x = Math.sin(seed.charCodeAt(0) + i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  let nodes = '';
  const pts = [];
  for (let i = 0; i < 14; i++) {
    const x = 120 + rnd(i) * (w - 240), y = 80 + rnd(i + 99) * (h - 160);
    pts.push([x, y]);
  }
  // connect nearby nodes
  let links = '';
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      if (dx * dx + dy * dy < 220 * 220) {
        links += `<line x1="${pts[i][0].toFixed(0)}" y1="${pts[i][1].toFixed(0)}" x2="${pts[j][0].toFixed(0)}" y2="${pts[j][1].toFixed(0)}" stroke="#${c.mintLt}" stroke-width="2" opacity="0.5"/>`;
      }
    }
  }
  pts.forEach((p, i) => {
    const col = [c.mint, c.mintLt, c.coral, c.amber][i % 4];
    const r = 8 + rnd(i + 7) * 16;
    nodes += `<circle cx="${p[0].toFixed(0)}" cy="${p[1].toFixed(0)}" r="${r.toFixed(0)}" fill="#${col}" opacity="${(0.55 + rnd(i + 3) * 0.4).toFixed(2)}"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#${c.dark}"/><stop offset="1" stop-color="#${c.primary}"/>
  </linearGradient>
  <radialGradient id="b1" cx="30%" cy="25%" r="60%"><stop offset="0" stop-color="#${c.mint}" stop-opacity="0.45"/><stop offset="1" stop-color="#${c.mint}" stop-opacity="0"/></radialGradient></defs>
  <rect width="${w}" height="${h}" rx="0" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#b1)"/>
  <circle cx="${w * 0.82}" cy="${h * 0.2}" r="${h * 0.32}" fill="#${c.mint}" opacity="0.14"/>
  <circle cx="${w * 0.15}" cy="${h * 0.85}" r="${h * 0.26}" fill="#${c.coral}" opacity="0.12"/>
  ${links}${nodes}
</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buf, source: 'svg', url: null };
}

/** Detect image mime from magic bytes (pptxgenjs needs the right prefix). */
function mime(buf) {
  if (!buf || buf.length < 4) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  return 'image/png';
}

/** pptxgenjs-ready dataURL for any buffer (correct mime prefix). */
function dataUrl(buf) { return mime(buf) + ';base64,' + buf.toString('base64'); }

/** Center-crop an image to an exact pixel ratio (cover) — used for thumbnails so they never stretch/squish. */
async function cover(buf, wPx, hPx) {
  return sharp(buf).resize({ width: wPx, height: hPx, fit: 'cover', position: 'center' }).toBuffer();
}

module.exports = { getImage, svgHero, dataUrl, cover, mime, pexels, unsplash, pixabay, local, normalize };
