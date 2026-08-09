// style.js — visual "style" system so different decks don't look stamped from one template.
//
// A style bundles cohesive choices across four layout axes:
//   header:    pill | bar | center        (how the page title band looks)
//   cover:     photo | split | solid      (cover-slide treatment)
//   card:      shadow | flat | line       (content-card treatment)
//   decorate:  ovals | bars | dots | none (cover/closing motif)
//
// classic == the original look (back-compat). Other styles visibly change the deck's DNA.
// The outline compiler auto-picks a style from the topic hash (deterministic) when none is given,
// so two different topics come out visually different without anyone choosing by hand.

const STYLES = {
  // the original harness look — full-bleed photo cover, mint pill headers, white shadow cards
  classic:   { header: 'pill',   cover: 'photo',  card: 'shadow', decorate: 'ovals' },
  // editorial: split cover, accent-bar headers, flat tinted cards — magazine feel
  editorial: { header: 'bar',    cover: 'split',  card: 'flat',   decorate: 'bars' },
  // minimal: solid cover, centered headers, hairline cards, no motif — gallery feel
  minimal:   { header: 'center', cover: 'solid',  card: 'line',   decorate: 'none' },
  // tech: photo cover, pill headers, shadow cards, dot-grid motif
  tech:      { header: 'pill',   cover: 'photo',  card: 'shadow', decorate: 'dots' },
  // bold: solid dark cover, accent-bar headers, flat cards, bar motif — punchy
  bold:      { header: 'bar',    cover: 'solid',  card: 'flat',   decorate: 'bars' },
};

const DEFAULT_STYLE = 'classic';
const STYLE_NAMES = Object.keys(STYLES);

function resolveStyle(name) {
  if (!name || !STYLES[name]) return STYLES[DEFAULT_STYLE];
  return Object.assign({ name }, STYLES[name]);
}

// Deterministic 32-bit string hash (Math.random is banned in workflow scripts; this is stable).
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Pick a style deterministically from a topic so the same topic reproduces but different
// topics diverge. 'classic' is excluded from the auto-rotation (it's the plain fallback) so
// auto-styled decks always get one of the more distinctive looks.
function pickStyleForTopic(topic) {
  const rotation = ['editorial', 'minimal', 'tech', 'bold'];
  return rotation[hash(topic || 'deck') % rotation.length];
}

module.exports = { STYLES, STYLE_NAMES, DEFAULT_STYLE, resolveStyle, pickStyleForTopic, hash };
