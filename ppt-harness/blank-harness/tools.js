// tools.js — T: the Tool registry (typed, VALIDATED tool interface).
//
// Tools are registered ONCE with a name, description, JSON-Schema (input_schema), and a run()
// handler. The agent never calls handlers directly — it goes through registry.execute(), which
// VALIDATES the model's input against the schema first (the gap that was missing: previously the
// model could pass bad args and only hit a runtime error inside the tool). This is the "typed,
// verified tool interface" of the harness.

const geo = require('./geometry');

// ---- lightweight JSON-Schema validator (no deps) ----
// supports: type (object/string/number/integer/boolean/array), required, properties (recursive),
// enum, minimum/maximum, items. Returns {ok, msg}.
function validateInput(schema, input) {
  if (!schema) return { ok: true };
  const v = (val, sch, path) => {
    if (sch == null) return { ok: true };
    if (sch.enum && !sch.enum.includes(val)) return { ok: false, msg: `${path}: must be one of ${JSON.stringify(sch.enum)}` };
    if (sch.type) {
      const t = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
      if (sch.type === 'integer' && !(t === 'number' && Number.isInteger(val))) return { ok: false, msg: `${path}: expected integer` };
      else if (sch.type !== 'integer' && t !== sch.type) return { ok: false, msg: `${path}: expected ${sch.type}, got ${t}` };
    }
    if (sch.type === 'number' || sch.type === 'integer') {
      if (sch.minimum != null && val < sch.minimum) return { ok: false, msg: `${path}: must be >= ${sch.minimum}` };
      if (sch.maximum != null && val > sch.maximum) return { ok: false, msg: `${path}: must be <= ${sch.maximum}` };
    }
    if (sch.type === 'object') {
      for (const req of (sch.required || [])) if (val[req] == null) return { ok: false, msg: `${path}.${req}: missing required field` };
      for (const k of Object.keys(sch.properties || {})) {
        if (val[k] != null) { const r = v(val[k], sch.properties[k], `${path}.${k}`); if (!r.ok) return r; }
      }
    }
    if (sch.type === 'array' && sch.items) for (let i = 0; i < val.length; i++) { const r = v(val[i], sch.items, `${path}[${i}]`); if (!r.ok) return r; }
    return { ok: true };
  };
  return v(input, schema, 'input');
}

class Registry {
  constructor() { this.tools = new Map(); }
  register(def) {
    if (!def || !def.name || !def.run) throw new Error('tool needs name + run');
    this.tools.set(def.name, def);
    return this;
  }
  get(name) { return this.tools.get(name); }
  has(name) { return this.tools.has(name); }
  // the list shape the Messages API expects
  apiList() { return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })); }
  names() { return [...this.tools.keys()]; }
  // VALIDATE then run. Returns {ok, result} | {ok:false, error}.
  async execute(name, input) {
    const t = this.tools.get(name);
    if (!t) return { ok: false, error: 'unknown tool "' + name + '". available: ' + this.names().join(', ') };
    const chk = validateInput(t.input_schema, input || {});
    if (!chk.ok) return { ok: false, error: 'invalid arguments: ' + chk.msg };
    try { return { ok: true, result: String(await t.run(input || {})) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
}

// ---- the whitespace-harness tools, registered against a loaded deck + a shared ctx ----
// ctx = { drawn:{}, finished:null }; deck = {slides:[{n, role, title, boxes}]}
function registerBlankTools(registry, deck, ctx) {
  const slide = (n) => deck.slides.find((s) => s.n === Number(n));
  const num = (v) => (v == null ? null : Number(v));

  registry.register({
    name: 'list_slides', description: '列出整份 PPT 的页码、角色(cover/content/closing)、构图原型与文字摘要，供决定检查哪些页。',
    input_schema: { type: 'object', properties: {} },
    run: () => JSON.stringify(deck.slides.map((s) => ({ page: s.n, role: s.role, arch: s.arch || '', title: String(s.title).slice(0, 30), textExcerpt: String(s.text || '').slice(0, 40) }))),
  });
  registry.register({
    name: 'measure_page', description: '查看某页的版面内容概览：各类元素数量、大块面位置等。',
    input_schema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
    run: (a) => {
      const s = slide(a.page); if (!s) return 'no such page';
      const kinds = {}; s.boxes.forEach((b) => { kinds[b.layer] = (kinds[b.layer] || 0) + 1; });
      const big = s.boxes.filter((b) => ['card', 'shape', 'image'].includes(b.layer) && b.w * b.h >= 2.5)
        .map((b) => `(${b.layer} ${b.w.toFixed(1)}×${b.h.toFixed(1)} @${b.x.toFixed(1)},${b.y.toFixed(1)})`);
      return JSON.stringify({ page: s.n, role: s.role, counts: kinds, bigElements: big });
    },
  });
  registry.register({
    name: 'read_page_text', description: '读取某页的完整文字内容(标题/要点/描述等)。判定留白前务必先读，以区分「刻意极简」与「内容过少」。',
    input_schema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
    run: (a) => {
      const s = slide(a.page); if (!s) return 'no such page';
      return JSON.stringify({ page: s.n, role: s.role, arch: s.arch || '', title: String(s.title).slice(0, 60), text: s.text || '(无文字)' });
    },
  });
  registry.register({
    name: 'find_empty_regions', description: '让系统精确测量某页的候选空白矩形(坐标英寸)。返回各区域坐标/大小/占比/方位。',
    input_schema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
    run: (a) => {
      const s = slide(a.page); if (!s) return 'no such page';
      const c = geo.candidatesFor(s);
      if (!c.regions.length) return JSON.stringify({ page: s.n, role: s.role, regions: [] });
      return JSON.stringify({ page: s.n, role: s.role, isHero: c.isHero, regions: c.regions.map((r, i) => ({ id: 'R' + (i + 1), x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2), pct: +(r.area / geo.SLIDE_AREA * 100).toFixed(0), where: geo.where(r) })) });
    },
  });
  registry.register({
    name: 'find_thin_blocks', description: '找某页"框大字少"的方框：大方框里内容占比很低。',
    input_schema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
    run: (a) => {
      const s = slide(a.page); if (!s) return 'no such page';
      const c = geo.candidatesFor(s);
      if (!c.thin.length) return JSON.stringify({ page: s.n, thin: [] });
      return JSON.stringify({ page: s.n, thin: c.thin.map((t, i) => ({ id: 'T' + (i + 1), x: +t.panel.x.toFixed(2), y: +t.panel.y.toFixed(2), w: +t.panel.w.toFixed(2), h: +t.panel.h.toFixed(2), contentFillPct: +(t.ratio * 100).toFixed(0) })) });
    },
  });
  registry.register({
    name: 'draw_red_box', description: '给一个已确认的留白问题画红框标注(坐标英寸)。仅在判定为真问题时调用。',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
        severity: { type: 'string', enum: ['high', 'medium', 'low', 'uncertain'] }, reason: { type: 'string' },
      },
      required: ['page', 'x', 'y', 'w', 'h'],
    },
    run: (a) => {
      const x = num(a.x), y = num(a.y), w = num(a.w), h = num(a.h);
      if ([x, y, w, h].some((v) => !isFinite(v))) return 'ERROR: invalid coords';
      ctx.drawn[a.page] = ctx.drawn[a.page] || [];
      ctx.drawn[a.page].push({ x, y, w, h, severity: a.severity || 'medium', reason: a.reason || '', kind: 'blank' });
      return `drew red box on page ${a.page} at (${x},${y}) ${w}×${h}`;
    },
  });
  registry.register({
    name: 'finish', description: '提交最终结论：汇总你确认的留白问题(每条含 page 与坐标)。调用后结束。',
    input_schema: {
      type: 'object',
      properties: {
        blanks: { type: 'array', items: { type: 'object', properties: {
          page: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'uncertain'] }, reason: { type: 'string' },
        } } },
        summary: { type: 'string' },
      },
      required: ['blanks'],
    },
    run: (a) => { ctx.finished = a; return 'finished: ' + (a.blanks || []).length + ' blanks'; },
  });
}

module.exports = { Registry, validateInput, registerBlankTools };
