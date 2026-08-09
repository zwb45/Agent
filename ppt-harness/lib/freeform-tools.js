// lib/freeform-tools.js — the freeform element vocabulary as a typed, VALIDATED registry.
// This is the "T" (tool registry) component of the freeform path's H = (E,T,C,S,L,V) mapping,
// mirroring blank-harness/tools.js: each element kind the LLM may emit is registered with a
// JSON-Schema, and validateFreeElement / sanitizeFreeElements check LLM output before render so
// malformed or off-canvas elements are reported/repaired instead of silently mis-rendered.
//
// Companion to freeform.js (the renderer). freeform.js consumes sanitizeFreeElements + TOOLBOX.

const { Registry } = require('./registry');

const W = 13.33, H = 7.5;
const FREE = new Registry();
const COLOR = { type: 'string' };

// box kinds — require a position box x,y,w,h
const BOX_EXTRAS = {
  rect: { fill: COLOR, opacity: { type: 'number' } },
  rrect: { fill: COLOR, radius: { type: 'number' }, opacity: { type: 'number' } },
  text: { text: COLOR, size: { type: 'number' }, color: COLOR, align: { type: 'string', enum: ['left', 'center', 'right'] } },
  fit: { text: COLOR, min: { type: 'number' }, max: { type: 'number' }, color: COLOR, align: { type: 'string', enum: ['left', 'center', 'right'] } },
  bullets: { items: { type: 'array', items: { type: 'string' } }, color: COLOR },
  image: { q: COLOR, url: COLOR, img: COLOR, data: COLOR },
  tag: { text: COLOR, fill: COLOR, color: COLOR },
  ghost: { text: COLOR, size: { type: 'number' }, color: COLOR },
};
for (const k of Object.keys(BOX_EXTRAS)) {
  FREE.register({
    name: k,
    input_schema: { type: 'object', properties: Object.assign({ x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, BOX_EXTRAS[k]), required: ['x', 'y', 'w', 'h'] },
  });
}
// diameter kinds — x,y + (d | w)
for (const k of ['oval', 'badge', 'icon']) {
  FREE.register({
    name: k,
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, d: { type: 'number' }, w: { type: 'number' }, fill: COLOR, color: COLOR, bg: COLOR }, required: ['x', 'y'] },
  });
}
// line — two endpoints
FREE.register({
  name: 'line',
  input_schema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, color: COLOR, w: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] },
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function validateFreeElement(el) {
  if (!el || typeof el !== 'object') return { ok: false, msg: 'element is not an object' };
  if (!el.k) return { ok: false, msg: 'element missing k' };
  const v = FREE.validate(el.k, el);
  if (!v.ok) return v;
  const fields = el.k === 'line' ? ['x1', 'y1', 'x2', 'y2'] : ['x', 'y'];
  for (const f of fields) if (!isFinite(el[f])) return { ok: false, msg: el.k + '.' + f + ': not finite' };
  return { ok: true };
}

// Validate + repair: drop malformed elements, clamp coords into the canvas. Does not mutate inputs.
function sanitizeFreeElements(els) {
  const kept = [], errors = [];
  for (const e of (Array.isArray(els) ? els : [])) {
    const v = validateFreeElement(e);
    if (!v.ok) { errors.push({ k: e && e.k, msg: v.msg }); continue; }
    const c = Object.assign({}, e);
    if (c.k === 'line') {
      c.x1 = clamp(c.x1, 0, W); c.y1 = clamp(c.y1, 0, H); c.x2 = clamp(c.x2, 0, W); c.y2 = clamp(c.y2, 0, H);
    } else {
      if (c.x != null) c.x = clamp(c.x, 0, W - 0.1);
      if (c.y != null) c.y = clamp(c.y, 0, H - 0.1);
      if (c.w != null) c.w = Math.max(0.1, Math.min(W - (c.x || 0), c.w));
      if (c.h != null) c.h = Math.max(0.1, Math.min(H - (c.y || 0), c.h));
      if (c.d != null) c.d = Math.max(0.1, Math.min(Math.min(W, H), c.d));
    }
    kept.push(c);
  }
  return { kept, errors };
}

// Human-readable toolbox description for the LLM authoring prompt (canonical home).
const TOOLBOX = `自由版式元素工具箱（freeform slide）。画布 13.33"(宽) × 7.5"(高)，建议留 0.6" 边距。坐标/尺寸单位为英寸，原点左上。颜色用调色板键(dark/primary/mint/mintLt/coral/amber/violet/teal/ink/slate/muted/offWhite/cardTint/white)或 6 位 hex。字体默认微软雅黑。
slide = { t:"free", bg:<颜色 或 {img:"英文搜图词", overlay:40}>, note?:"来源", elements:[ ... ] }
元素 kinds（每个都有 x,y,w,h 或相应字段）：
- rect/rrect : {k:"rrect", x,y,w,h, fill, radius?, shadow?, opacity?, line?:{color,width}, rotate?}  矩形/圆角卡片
- oval       : {k:"oval", x,y,d, fill, opacity?, rotate?}                  圆/椭圆(装饰/光斑)
- text       : {k:"text", x,y,w,h, text, size?, bold?, italic?, color?, align?, valign?, rotate?, spacing?}  定字号文本
- fit        : {k:"fit", x,y,w,h, text, min?, max?, bold?, color?, align?, valign?, rotate?}   ★自适应字号填满盒子
- bullets    : {k:"bullets", x,y,w,h, items:[...], min?, max?, color?}     ★自适应项目列表填满盒子
- image      : {k:"image", x,y,w,h, q:"英文搜图词", rotate?, plain?}         配图(自动去重;图片要在方框之后=上层)
- icon       : {k:"icon", x,y,d, spec:"lu/LuBrain", bg?, color?}           图标(bg 给色=圆形徽章)
- badge      : {k:"badge", x,y,d, num:"3", color?}                         数字徽章
- tag        : {k:"tag", x,y,w,h, text, fill?, color?}                     ★药丸标签/眉标(小圆角+居中字)
- ghost      : {k:"ghost", x,y,w,h, text, size?, color?}                   ★淡淡的背景大字/数字(编辑感,放底层,渲染会自动变淡+限尺寸,别指望它显眼)
- line       : {k:"line", x1,y1,x2,y2, color?, w?}                         连接线/分隔线
设计要求：① 你决定整体构图（杂志式/非对称/对角/海报…），每页不同、有创意、不套模板；② 大胆用 ghost 背景字、tag 眉标、rotate 倾斜色块、oval 光斑等增加设计感；③ 用 fit/bullets 让文字填满盒子、严禁大片留白；④ 元素不得重叠、不得越出画布；⑤ 图文并茂，每个大块/案例都配图。`;

// Estimate wrapped line count for mixed CJK/latin text (mirrors lib/review.js estLines).
function estLines(t, fsPt, boxW) {
  if (!t) return 0;
  const fsIn = fsPt / 72;
  let lines = 0;
  for (const seg of String(t).split('\n')) {
    let w = 0;
    for (const ch of seg) {
      if (/[　-鿿＀-￯]/.test(ch)) w += fsIn * 1.04;
      else if (ch === ' ' || ch === '\t') w += fsIn * 0.30;
      else w += fsIn * 0.56;
    }
    lines += Math.max(1, Math.ceil(w / Math.max(0.4, boxW - 0.18)));
  }
  return lines;
}

// DETERMINISTIC z-order repair (the reliable fix for "image/text covered by a filled box"):
// decor (ghost/oval) → bottom, opaque containers (rect/rrect fill, no transparency) → behind content,
// content (text/image/icon/...) → top. So a panel can never cover the content placed on it, and decor
// never sits over text. Big panels go furthest back. Does NOT rely on the LLM getting order right.
function fixZOrder(els) {
  const decor = [], cont = [], content = [];
  for (const e of (Array.isArray(els) ? els : [])) {
    if (!e || !e.k) continue;
    if (e.k === 'ghost' || e.k === 'oval') decor.push(e);
    else if ((e.k === 'rect' || e.k === 'rrect') && e.fill && e.opacity == null) cont.push(e);
    else content.push(e);
  }
  cont.sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0));
  return [...decor, ...cont, ...content];
}

module.exports = { FREE, validateFreeElement, sanitizeFreeElements, fixZOrder, estLines, TOOLBOX, W, H };
