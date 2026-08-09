#!/usr/bin/env node
// eval-blanks.js — human-evaluation driver (standalone).
//   node eval-blanks.js <deck.pptx>            # detect → 评估表 HTML (浏览器逐框判 TP/FP, 实时通过率)
//   node eval-blanks.js --judgments j.json     # 复算精确率 (是否 ≥90%)
const fs = require('fs'), path = require('path'), { exec } = require('child_process');
const { detect, visualize } = require('./detect');
const ev = require('./eval');

const arg = (n, fb) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fb; };

async function main() {
  const jFile = arg('judgments');
  if (jFile) {
    const J = JSON.parse(fs.readFileSync(jFile, 'utf8'));
    const s = ev.computePrecision(J.judgments || J);
    console.log(`TP=${s.tp}  FP=${s.fp}  skipped=${s.skipped}`);
    if (s.precisionPct == null) return console.log('（无有效判定）');
    console.log(`通过率 = ${s.precisionPct}%  ${s.pass90 ? '✓ ≥90%' : '✗ <90%'}`);
    console.log('分 severity:', JSON.stringify(s.perSeverity));
    return;
  }
  const deck = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!deck) { console.error('Usage:\n  node eval-blanks.js <deck.pptx>\n  node eval-blanks.js --judgments j.json'); process.exit(1); }
  const abs = path.resolve(deck); if (!fs.existsSync(abs)) { console.error('not found'); process.exit(1); }
  const base = path.basename(abs, '.pptx'), dir = path.dirname(abs);
  console.log('运行检测…');
  const report = await detect(abs, { onLog: (m) => console.log('  ' + m) });
  const flagged = report.slides.reduce((n, s) => n + s.blanks.length, 0);
  if (!flagged) { console.log('\n✓ 未检出留白框——无需评估。'); return; }
  const pngDir = path.join(dir, 'blankcheck');
  if (report.slides.some((s) => s.blanks.length && !fs.existsSync(path.join(pngDir, `${base}-blank-${String(s.n).padStart(2, '0')}.png`)))) await visualize(report);
  const html = ev.makeEvalHTML(report, pngDir, base);
  const out = path.join(dir, `${base}.blankcheck.eval.html`);
  fs.writeFileSync(out, html);
  console.log(`\n✓ 评估表: ${out}\n  共 ${flagged} 框，浏览器里逐个判 → 导出 JSON → 用 --judgments 复算。`);
  const cmd = process.platform === 'win32' ? `start "" "${out}"` : process.platform === 'darwin' ? `open "${out}"` : `xdg-open "${out}"`;
  exec(cmd, () => {});
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
