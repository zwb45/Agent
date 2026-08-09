// schema.js — declarative description of every slide type + validateSlides().
// Two purposes: (1) a self-documenting contract an LLM can emit slides against,
// (2) a pre-build gate that catches malformed LLM output before pptxgenjs sees it.
//
// Validation is deliberately lenient about MISSING fields (most renderers no-op on
// undefined) but strict about TYPE errors and UNKNOWN slide types — those are the
// mistakes an LLM is most likely to make and that would silently produce a broken deck.

// field spec: { req?: true, type: 'string'|'number'|'boolean'|'array'|'object', item?: 'object' }
const T = {
  str: { type: 'string' },
  str_: { type: 'string' },          // optional (alias for readability)
  num: { type: 'number' },
  num_: { type: 'number' },
  bool: { type: 'boolean' },
  bool_: { type: 'boolean' },
  arr: { type: 'array' },
  arr_: { type: 'array' },
  obj: { type: 'object' },
  obj_: { type: 'object' },
};

const FIELDS = {
  // universal optional richness fields (documented; not enforced on every type)
  _common: { id: T.str_, eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_, notes: T.str_, img: { type: 'string' }, overlay: T.num_, topic: T.str_ },

  cover:    { req: { title: T.str }, opt: { eyebrow: T.str_, subtitle: T.str_, img: T.str_, meta: T.str_, overlay: T.num_, topic: T.str_ } },
  divider:  { req: { title: T.str }, opt: { eyebrow: T.str_, subtitle: T.str_, img: T.str_, overlay: T.num_, points: T.arr_, topic: T.str_ } },
  agenda:   { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_,
              items: { type: 'array', item: 'object', itemFields: { title: T.str, desc: T.str_ } } } },
  stats:    { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_,
              stats: { type: 'array', item: 'object', itemFields: { big: T.str, label: T.str, sub: T.str_ } },
              cols: { type: 'array', item: 'object', itemFields: { title: T.str, bullets: T.arr } } } },
  iconGrid: { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_, images: T.bool_,
              cards: { type: 'array', item: 'object', itemFields: { icon: T.str_, title: T.str, desc: T.str_, img: T.str_ } } } },
  chart:    { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, bullets: T.arr_, note: T.str_,
              stat: { type: 'object', itemFields: { big: T.str, desc: T.str_ } },
              chart: { type: 'object', itemFields: { title: T.str_, cats: T.arr, vals: T.arr, suffix: T.str_, dataLabelFmt: T.str_, color: T.str_, max: T.num_, min: T.num_, step: T.num_, gap: T.num_, xTitle: T.str_, yTitle: T.str_, seriesName: T.str_ } } } },
  flow:     { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, note: T.str_, heading: T.str_,
              stats: { type: 'array', item: 'object', itemFields: { big: T.str, label: T.str } },
              steps: { type: 'array', item: 'object', itemFields: { icon: T.str_, title: T.str, desc: T.str_ } } } },
  pipeline: { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, note: T.str_, heading: T.str_,
              stats: { type: 'array', item: 'object', itemFields: { big: T.str, label: T.str } },
              phases: { type: 'array', item: 'object', itemFields: { title: T.str, desc: T.str_, accel: T.bool_ } } } },
  twoCol:   { req: { title: T.str, left: { type: 'object', itemFields: { title: T.str, bullets: T.arr_, lead: T.str_ } } },
              opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_, img: T.str_, caption: T.str_,
              right: { type: 'array', item: 'object', itemFields: { big: T.str, label: T.str } } } },
  quadrant: { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_, images: T.bool_,
              cards: { type: 'array', item: 'object', itemFields: { icon: T.str_, title: T.str, desc: T.str_, img: T.str_ } } } },
  future:   { req: { title: T.str }, opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_, images: T.bool_,
              cards: { type: 'array', item: 'object', itemFields: { icon: T.str_, title: T.str, desc: T.str_, img: T.str_ } } } },
  table:    { req: { title: T.str, columns: { type: 'array', item: 'object', itemFields: { header: T.str, key: T.str } } },
              opt: { eyebrow: T.str_, sub: T.str_, lead: T.str_, note: T.str_, img: T.str_,
              rows: { type: 'array' } } },
  closing:  { req: {}, opt: { eyebrow: T.str_, title: T.str_, sub: T.str_, thanks: T.str_, note: T.str_ } },
  free:     { req: { elements: { type: 'array' } }, opt: { note: T.str_, eyebrow: T.str_, title: T.str_ } },
};

const TYPES = Object.keys(FIELDS).filter((k) => k !== '_common');

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Check one field value against a spec, push errors into `out`.
function checkField(path, val, spec, out) {
  const kind = spec.type;
  const got = typeOf(val);
  if (kind === 'array' && got !== 'array') { out.push(`${path}: expected array, got ${got}`); return; }
  if (kind === 'object' && got !== 'object') { out.push(`${path}: expected object, got ${got}`); return; }
  if (kind === 'string' && got !== 'string') { out.push(`${path}: expected string, got ${got}`); return; }
  if (kind === 'number' && got !== 'number') { out.push(`${path}: expected number, got ${got}`); return; }
  if (kind === 'boolean' && got !== 'boolean') { out.push(`${path}: expected boolean, got ${got}`); return; }
  // recurse into typed array items
  if (kind === 'array' && spec.item === 'object' && spec.itemFields) {
    val.forEach((it, i) => {
      if (typeOf(it) !== 'object') { out.push(`${path}[${i}]: expected object, got ${typeOf(it)}`); return; }
      for (const [fk, fs] of Object.entries(spec.itemFields)) {
        if (it[fk] == null) { if (fs.req) out.push(`${path}[${i}].${fk}: missing required field`); continue; }
        checkField(`${path}[${i}].${fk}`, it[fk], fs, out);
      }
    });
  }
  // recurse into a sub-object spec
  if (kind === 'object' && spec.itemFields) {
    for (const [fk, fs] of Object.entries(spec.itemFields)) {
      if (val[fk] == null) { if (fs.req) out.push(`${path}.${fk}: missing required field`); continue; }
      checkField(`${path}.${fk}`, val[fk], fs, out);
    }
  }
}

/**
 * Validate a slides array. Returns { ok, errors, warnings }.
 * errors   -> hard problems (unknown type, wrong shape) that will break the build.
 * warnings -> soft hints (page looks empty / missing common fields).
 */
function validateSlides(slides) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(slides)) return { ok: false, errors: ['slides: expected an array'], warnings };

  slides.forEach((spec, i) => {
    const where = `slide ${i + 1}`;
    if (typeOf(spec) !== 'object') { errors.push(`${where}: expected an object, got ${typeOf(spec)}`); return; }
    const t = spec.t;
    if (!t) { errors.push(`${where}: missing required field "t" (slide type)`); return; }
    const def = FIELDS[t];
    if (!def) { errors.push(`${where}: unknown slide type "${t}". Valid: ${TYPES.join(', ')}`); return; }

    // required fields present
    for (const [fk, fs] of Object.entries(def.req || {})) {
      if (spec[fk] == null) errors.push(`${where}: missing required field "${fk}" for type "${t}"`);
      else checkField(`${where}.${fk}`, spec[fk], fs, errors);
    }
    // optional fields, if present, must be the right type
    for (const [fk, fs] of Object.entries(def.opt || {})) {
      if (spec[fk] != null) checkField(`${where}.${fk}`, spec[fk], fs, errors);
    }

    // soft warnings: content-bearing pages with no payload
    if (t === 'iconGrid' || t === 'quadrant' || t === 'future') {
      if (!spec.cards || !spec.cards.length) warnings.push(`${where} (${t}): no "cards" — page will be nearly empty`);
    }
    if (t === 'stats' && (!spec.stats || !spec.stats.length)) warnings.push(`${where} (stats): no "stats" array`);
    if (t === 'table' && (!spec.rows || !spec.rows.length)) warnings.push(`${where} (table): no "rows" array`);
    if (t === 'chart' && (!spec.chart || !spec.chart.cats || !spec.chart.vals)) warnings.push(`${where} (chart): missing chart.cats/vals`);
    if (t === 'flow' && (!spec.steps || !spec.steps.length)) warnings.push(`${where} (flow): no "steps" array`);
    if (t === 'pipeline' && (!spec.phases || !spec.phases.length)) warnings.push(`${where} (pipeline): no "phases" array`);
  });

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { FIELDS, TYPES, validateSlides, typeOf };
