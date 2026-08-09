#!/usr/bin/env node
// edit.js — CLI: apply edits to an existing deck.
//
// SPEC MODE (decks made by this harness — full power, rebuilds from the saved spec):
//   node edit.js --spec examples/output/deck.pptx.spec.json --edits my-edits.json
//   node edit.js --spec deck.pptx.spec.json --edits my-edits.json --out deck-v2.pptx --no-images
//
// LIVE MODE (ANY .pptx — text replace / delete / reorder via python-pptx, best-effort):
//   node edit.js --live some-deck.pptx --edits my-edits.json
//
// edits.json is a JSON array of edit ops (see lib/edit.js for the full op list).

const fs = require('fs');
const path = require('path');
const { applyEdits, applyEditsLive } = require('./lib/edit');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes('--' + name); }

function loadEdits(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.edits;
  // drop comment-only entries (e.g. { "//": "..." }); keep anything that has an "op".
  return arr.filter((e) => e && typeof e === 'object' && e.op);
}

async function main() {
  const specPath = arg('spec');
  const livePath = arg('live');
  const editsFile = arg('edits');
  if ((!specPath && !livePath) || !editsFile) {
    console.error('Usage:\n  node edit.js --spec <file.spec.json> --edits <edits.json> [--out <pptx>] [--no-images]\n  node edit.js --live <file.pptx>   --edits <edits.json> [--out <pptx>]');
    process.exit(1);
  }
  const edits = loadEdits(editsFile);
  console.log('EDITS: ' + edits.length + ' op(s): ' + edits.map((e) => e.op).join(', '));

  if (specPath) {
    const out = await applyEdits({
      specPath,
      edits,
      out: arg('out'),
      useImages: !flag('no-images'),
    });
    console.log('EDITED → ' + out);
  } else {
    const r = applyEditsLive({ pptx: livePath, edits, out: arg('out') });
    console.log('LIVE EDIT → ' + r.out + '  (text replaced on ' + (r.counts.text || 0) + ' shape(s))');
  }
}

main().catch((e) => { console.error('EDIT FAILED:', e.message); process.exit(1); });
