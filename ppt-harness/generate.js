#!/usr/bin/env node
// generate.js — CLI: build a deck from an OUTLINE (terse) or a raw SLIDES spec.
//
//   Outline mode (recommended for LLM/human authoring — compiler fills icons, images,
//   cover/agenda/closing, eyebrow numbers):
//     node generate.js --outline examples/ai-healthcare-outline.json
//     node generate.js --outline outline.json --out output/deck.pptx --no-images
//
//   Spec mode (full pre-written slides array, validated then built):
//     node generate.js --spec slides.json
//
// The outline/spec file may be .json (parsed) or .js (module.exports = {...}).

const fs = require('fs');
const path = require('path');
const { build } = require('./harness');
const { outlineToSlides } = require('./lib/generate');
const { validateSlides } = require('./lib/schema');
const styleMod = require('./lib/style');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes('--' + name); }

function loadFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) { console.error('file not found: ' + file); process.exit(1); }
  return abs.endsWith('.js') ? require(abs) : JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function report(v) {
  if (v.errors.length) {
    console.error('VALIDATION FAILED (' + v.errors.length + ' errors):');
    v.errors.forEach((e) => console.error('  ✗ ' + e));
  }
  if (v.warnings.length) v.warnings.forEach((w) => console.error('  ⚠ ' + w));
  return v.ok;
}

async function main() {
  const outlineFile = arg('outline');
  const specFile = arg('spec');
  if (!outlineFile && !specFile) {
    console.error('Usage:\n  node generate.js --outline <file.json|js> [--out <pptx>] [--no-images] [--theme <name>] [--style <name>]\n  node generate.js --spec <file.json|js>   [--out <pptx>] [--no-images]');
    process.exit(1);
  }

  let slides, buildOpts;
  if (outlineFile) {
    const o = loadFile(outlineFile);
    slides = outlineToSlides(o);
    const d = o.design || {};
    buildOpts = {
      palette: d.palette || o.palette,
      theme: arg('theme', d.theme || o.theme || ((d.palette || o.palette) ? undefined : 'healthcare')),
      style: arg('style', d.style || o.style),
      header: d.header || o.header, cover: d.cover || o.cover, card: d.card || o.card, decorate: d.decorate || o.decorate,
      typography: d.typography || o.typography,
      title: o.topic || o.title || 'PPT Harness Deck',
      footerLabel: o.footerLabel || o.topic,
    };
    // No design authored? auto-pick a style from the topic so different topics look different.
    if (!buildOpts.style && !buildOpts.header && !buildOpts.cover && !buildOpts.card && !buildOpts.decorate) {
      buildOpts.style = styleMod.pickStyleForTopic(o.topic || 'deck');
    }
    console.log('OUTLINE → ' + slides.length + ' slides (' + slides.map((s) => s.t).join(', ') + ')');
  } else {
    const s = loadFile(specFile);
    slides = Array.isArray(s) ? s : s.slides;
    buildOpts = {
      palette: s.palette,
      theme: arg('theme', s.theme || (s.palette ? undefined : 'healthcare')),
      style: arg('style', s.style),
      header: s.header, cover: s.cover, card: s.card, decorate: s.decorate,
      title: s.title || s.deck, footerLabel: s.footerLabel, typography: s.typography,
    };
  }

  const v = validateSlides(slides);
  if (!report(v)) process.exit(1);
  if (v.warnings.length === 0 && v.errors.length === 0) console.log('VALIDATE: PASS (' + slides.length + ' slides)');

  const noImages = flag('no-images');
  const out = arg('out', path.join(process.cwd(), 'output', (outlineFile || specFile).replace(/\.(json|js)$/, '').split(/[\\/]/).pop() + (noImages ? '-noimg' : '') + '.pptx'));

  await build(Object.assign({}, buildOpts, {
    slides,
    out,
    useImages: !noImages,
  }));
}

main().catch((e) => { console.error('BUILD FAILED:', e); process.exit(1); });
