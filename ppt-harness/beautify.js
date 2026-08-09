#!/usr/bin/env node
// beautify.js — CLI: re-layout an existing deck so it reads as designed.
//
// From a saved spec (a harness deck):
//   node beautify.js --spec examples/output/deck.pptx.spec.json [--out v2.pptx] [--gentle] [--theme midnight] [--no-images]
//
// From ANY .pptx (import its text/tables, then re-flow into polished layouts):
//   node beautify.js --import some-ugly-deck.pptx [--out beautified.pptx] [--theme midnight] [--compare]
//
// --gentle : only prune/balance/normalize (keep the author's slide types). Default re-types.
// --compare: (--import only) also render the original to PNGs for a before/after eyeball.

const fs = require('fs');
const path = require('path');
const { build } = require('./harness');
const { beautifySpec, importPptx } = require('./lib/beautify');
const { validateSlides } = require('./lib/schema');
const qa = require('./lib/qa');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes('--' + name); }

async function main() {
  const specPath = arg('spec');
  const importPath = arg('import');
  if (!specPath && !importPath) {
    console.error('Usage:\n  node beautify.js --spec <file.spec.json> [--out <pptx>] [--gentle] [--theme <name>] [--no-images]\n  node beautify.js --import <file.pptx> [--out <pptx>] [--theme <name>] [--compare]');
    process.exit(1);
  }
  const mode = flag('gentle') ? 'gentle' : 'aggressive';
  const theme = arg('theme');

  let input;
  if (specPath) {
    input = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
    console.log('SOURCE spec: ' + specPath + ' (' + (input.slides || []).length + ' slides)');
  } else {
    const r = importPptx(importPath, { theme });
    input = r.spec;
    console.log('IMPORT ' + importPath + ' → ' + r.slidesParsed + ' slide(s) parsed');
    if (flag('compare')) {
      const beforeDir = path.join(path.dirname(path.resolve(arg('out', importPath))), 'preview-before');
      const rb = qa.renderAll(path.resolve(importPath), beforeDir);
      if (rb.pngs && rb.pngs.length) console.log('BEFORE render: ' + rb.pngs.length + ' PNGs → ' + path.dirname(rb.pngs[0]));
    }
  }

  const { spec, log } = beautifySpec(input, { mode, theme });
  console.log('\nBEAUTIFY ' + (mode === 'gentle' ? '(gentle' : '(aggressive') + ' re-layout) — ' + log.length + ' change(s):');
  log.forEach((l) => console.log('  • ' + l));

  const v = validateSlides(spec.slides);
  if (!v.ok) { console.error('\nVALIDATION FAILED:\n  ' + v.errors.join('\n  ')); process.exit(1); }
  console.log('\nVALIDATE: PASS (' + spec.slides.length + ' slides)');

  const base = specPath ? path.basename(specPath, '.pptx.spec.json') : path.basename(importPath, path.extname(importPath));
  const out = arg('out', path.join(process.cwd(), 'output', base + '-beautified.pptx'));
  await build({
    theme: spec.theme || 'healthcare',
    title: spec.deck,
    footerLabel: spec.footerLabel || spec.deck,
    typography: spec.typography,
    slides: spec.slides,
    out,
    useImages: !flag('no-images'),
  });
  console.log('\nBEAUTIFIED → ' + out);
}

main().catch((e) => { console.error('BEAUTIFY FAILED:', e.message); process.exit(1); });
