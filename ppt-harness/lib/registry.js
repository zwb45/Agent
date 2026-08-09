// lib/registry.js — a generic, dependency-free Tool / Element Registry with JSON-Schema input
// validation. The "T" component of the H = (E,T,C,S,L,V) harness mapping.
//
// This is the same validate-then-use pattern blank-harness/tools.js uses for its agent tools, lifted
// here so the freeform path can register its element vocabulary as a typed, VALIDATED interface
// (the LLM "uses a tool" by emitting an element of a registered kind; the harness validates it before
// rendering). blank-harness keeps its own copy to stay self-contained.

// Lightweight JSON-Schema validator (no deps). Supports: type (object/string/number/integer/boolean/
// array), required, properties (recursive), enum, minimum/maximum, items. Returns {ok, msg}.
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
    if (!def || !def.name) throw new Error('registry def needs a name');
    this.tools.set(def.name, def);
    return this;
  }
  get(name) { return this.tools.get(name); }
  has(name) { return this.tools.has(name); }
  names() { return [...this.tools.keys()]; }
  // Validate an input against the schema registered under `name`. Returns {ok, msg}.
  validate(name, input) {
    const t = this.tools.get(name);
    if (!t) return { ok: false, msg: 'unknown kind "' + name + '". available: ' + this.names().join(', ') };
    return validateInput(t.input_schema, input || {});
  }
}

module.exports = { Registry, validateInput };
