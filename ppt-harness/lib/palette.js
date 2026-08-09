// Color palettes for the harness. Each: dark/dominant, primary, accents, ink, slate, muted, offWhite, cardTint, white.
// Hex without '#', 6 digits (pptxgenjs requirement).

const PALETTES = {
  // Healthcare / medical-tech — trustworthy teal + mint, coral vitality accent
  healthcare: {
    name: 'healthcare',
    dark: '0D5C63', primary: '157F8B', mint: '2DBE9E', mintLt: '9BE3D2',
    coral: 'EF6F6C', amber: 'F2B05E', violet: '6C7BD8',
    ink: '102A2E', slate: '44585C', muted: '7C9095',
    offWhite: 'F4F9FA', cardTint: 'E7F2F1', white: 'FFFFFF',
    // ordered accent cycle for badges/icons across cards
    accents: ['157F8B', '2DBE9E', 'EF6F6C', 'F2B05E', '6C7BD8', '0D5C63'],
  },
  // Midnight executive — navy + ice blue + white
  midnight: {
    name: 'midnight', dark: '1E2761', primary: '2C3E8E', mint: '5C8DEF', mintLt: 'CADCFC',
    coral: 'E8505B', amber: 'F4C95D', violet: '8B7BD8',
    ink: '121A39', slate: '44507A', muted: '7B86AE',
    offWhite: 'F5F7FB', cardTint: 'E8EDF7', white: 'FFFFFF',
    accents: ['2C3E8E', '5C8DEF', 'E8505B', 'F4C95D', '8B7BD8', '1E2761'],
  },
  // Charcoal minimal — premium dark
  charcoal: {
    name: 'charcoal', dark: '1F2630', primary: '36454F', mint: '4DA3A6', mintLt: 'BFE0DE',
    coral: 'E5685E', amber: 'E9A23B', violet: '7E86C9',
    ink: '161B22', slate: '5A6671', muted: '8A95A0',
    offWhite: 'F2F3F5', cardTint: 'E7EAEE', white: 'FFFFFF',
    accents: ['4DA3A6', 'E9A23B', 'E5685E', '7E86C9', '36454F', '5A6671'],
  },
  // Berry & cream — warm editorial
  berry: {
    name: 'berry', dark: '6D2E46', primary: '8C3B5B', mint: 'C97B8C', mintLt: 'ECE2D0',
    coral: 'D9534F', amber: 'E0A458', violet: '6C5B7B',
    ink: '3A1C29', slate: '6E4A59', muted: '9C7B89',
    offWhite: 'FBF6F0', cardTint: 'F3E7DF', white: 'FFFFFF',
    accents: ['8C3B5B', 'C97B8C', 'E0A458', 'D9534F', '6C5B7B', '6D2E46'],
  },
};

function get(name) {
  return PALETTES[name] ? PALETTES[name] : PALETTES.healthcare;
}

// convert '#RRGGBB' or 'rgb(...)' -> 'RRGGBB'; pass through if already bare hex
function normalize(c) {
  if (!c) return c;
  if (c.startsWith('#')) return c.slice(1, 7).toUpperCase();
  if (c.startsWith('rgb')) {
    const m = c.match(/\d+/g);
    if (m && m.length >= 3) return m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return c.toUpperCase();
}

// Coerce a partial hex object (LLM-authored palette) into a full palette by filling any missing
// fields from the healthcare base. Lets the LLM define its own colors for a topic without having to
// know every internal key. accents[] is rebuilt from the provided colors if absent.
function coerce(obj) {
  const base = JSON.parse(JSON.stringify(PALETTES.healthcare));
  if (!obj || typeof obj !== 'object') return base;
  const out = Object.assign({}, base);
  for (const k of Object.keys(obj)) {
    if (k === 'accents') out.accents = (obj.accents || []).map(normalize).filter(Boolean);
    else if (k === 'name') out.name = obj.name;
    else out[k] = normalize(obj[k]);
  }
  if (!Array.isArray(out.accents) || !out.accents.length) {
    out.accents = [out.primary, out.mint, out.coral, out.amber, out.violet, out.dark].filter(Boolean);
  }
  if (!out.name) out.name = obj.name || 'custom';
  return out;
}

module.exports = { PALETTES, get, normalize, coerce };
