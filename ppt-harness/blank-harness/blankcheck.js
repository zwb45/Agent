#!/usr/bin/env node
// blankcheck.js — whitespace-detection CLI (standalone harness).
//   node blankcheck.js <deck.pptx>            # agentic: tools(T) + LLM brain + visualize
//   node blankcheck.js <deck.pptx> --no-llm   # geometry only (LLM not called)
//   node blankcheck.js <deck.pptx> --save report.json
// Reads the deck's captured geometry as data; draws confirmed blanks as red boxes onto PNGs.

const fs = require('fs'), path = require('path');
const { detect, visualize, summarize } = require('./detect');
const { Context } = require('./context'); // only used to short-circuit in --no-llm path
const geo = require('./geometry');

const flag = (n) => process.argv.includes('--' + n);
const arg = (n, fb) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fb; };

// geometry-only mode: skip the LLM, return all candidates as "unverified"
async function detectNoLLM(abs) {
  const { loadDeck } = require('./detect');
  const deck = loadDeck(abs);
  const slides = deck.slides.map((s) => {
    const c = geo.candidatesFor(s);
    const blanks = c.regions.map((r, i) => ({ x: r.x, y: r.y, w: r.w, h: r.h, area: r.area, severity: 'info', reason: '', kind: 'blank-rect' }))
      .concat(c.thin.map((t, i) => ({ x: t.panel.x, y: t.panel.y, w: t.panel.w, h: t.panel.h, area: t.panel.w * t.panel.h, severity: 'info', reason: '框大字少', kind: 'thin-block' })));
    return { n: s.n, role: s.role, blanks: geo.mergeOverlapping(blanks) };
  });
  return { deckPptx: abs, slides, summary: '(geometry only, no LLM)', steps: 0, toolCalls: 0, repeatedCalls: 0, compactions: 0 };
}

async function main() {
  const deck = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!deck) { console.error('Usage: node blankcheck.js <deck.pptx> [--no-llm] [--save r.json] [--max-chars N]'); process.exit(1); }
  const abs = path.resolve(deck);
  if (!fs.existsSync(abs)) { console.error('not found: ' + deck); process.exit(1); }
  console.log(`空白检测: ${path.basename(abs)}${flag('no-llm') ? '  (几何 only)' : '  (tools+LLM)'}`);
  const res = flag('no-llm') ? await detectNoLLM(abs) : await detect(abs, { maxChars: Number(arg('max-chars')) || undefined, onLog: (m) => console.log('  ' + m) });

  let shown = 0;
  for (const s of res.slides) {
    if (!s.blanks.length) continue;
    console.log(`\n第 ${s.n} 页 (${s.role}):`);
    for (const b of s.blanks) { shown++; console.log(`  [${b.severity}|${b.kind}] x=${b.x.toFixed(2)} y=${b.y.toFixed(2)} ${b.w.toFixed(2)}×${b.h.toFixed(2)}" (${(b.area / (geo.W * geo.H) * 100).toFixed(0)}%)${b.reason ? ' — ' + b.reason : ''}`); }
  }
  if (!shown) console.log('\n✓ 未发现需要处理的留白');
  console.log('\n' + summarize(res) + `  (steps=${res.steps}, toolCalls=${res.toolCalls}, repeats=${res.repeatedCalls}, compactions=${res.compactions})`);
  const v = await visualize(res);
  if (v.error) console.log('可视化: ' + v.error); else if (v.written.length) console.log(`可视化: ${v.written.length} 张 → ${v.outDir}/`);
  if (arg('save')) { const o = path.resolve(arg('save')); fs.writeFileSync(o, JSON.stringify(res, null, 2)); console.log('报告: ' + o); }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
